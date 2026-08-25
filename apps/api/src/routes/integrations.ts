import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { withApiPrefix } from "../api-prefix.js";
import { query } from "../db.js";
import { verifyAuth } from "../auth.js";
import { decryptToken, encryptToken } from "../integrations/crypto.js";
import {
  getProviderClient,
  isIntegrationProvider,
  resolveIntegrationStatus,
  type IntegrationProvider,
} from "../integrations/index.js";
import { isIntegrationNotConfiguredError } from "../integrations/errors.js";

interface OAuthStateRow {
  user_id: string;
  provider: IntegrationProvider;
  return_to: string;
  expires_at: Date;
}

interface UserIntegrationStatusRow {
  status: string;
  refresh_token_enc: string | null;
  token_expires_at: Date | null;
}

interface TokenRow {
  access_token_enc: string | null;
  refresh_token_enc: string | null;
}

interface IntegrationAuthorizeQuery {
  returnTo?: string;
}

interface IntegrationCallbackQuery {
  state?: string;
  code?: string;
  error?: string;
}

interface RequestOriginContext {
  protocol: string;
  headers: { host?: string | string[]; origin?: string | string[]; referer?: string | string[] };
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

// A browsable http(s) origin, or null. Electron renderers loaded from file://
// send `Origin: null`, which is not a URL and must not be treated as one.
function toBrowsableOrigin(value: string | null): string | null {
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Where the user should land after the OAuth round trip, or null when the
// request gives us nothing browsable to return to (the desktop app). Callers
// fall back to rendering a "you can close this tab" completion page.
function getIntegrationFrontendOrigin(req: RequestOriginContext): string | null {
  const explicit = toBrowsableOrigin(process.env.INTEGRATION_CALLBACK_ORIGIN?.trim() ?? null);
  if (explicit) return explicit;

  const headerOrigin = toBrowsableOrigin(firstHeaderValue(req.headers.origin));
  if (headerOrigin) return headerOrigin;

  const referer = firstHeaderValue(req.headers.referer);
  if (referer) {
    const refererOrigin = toBrowsableOrigin(referer);
    if (refererOrigin) return refererOrigin;
  }

  return null;
}

const DESKTOP_RETURN_TO = "app";

function randomState(): string {
  return randomBytes(24).toString("hex");
}

// Exported for tests.
// Resolves the caller's returnTo against the frontend origin, refusing anything
// that would send the user to a different site. Returns "" when there is no
// browsable frontend to return to, which the callback renders as a completion
// page instead of a redirect.
export function sanitizeReturnTo(
  raw: string | undefined,
  req: RequestOriginContext,
): string {
  const fallbackOrigin = getIntegrationFrontendOrigin(req);
  // `app` is the desktop app's way of saying "there is no web page to return to".
  if (raw === DESKTOP_RETURN_TO || !fallbackOrigin) return "";
  if (!raw || raw.length > 1024) return fallbackOrigin;

  try {
    const parsed = new URL(raw, fallbackOrigin);
    if (parsed.origin !== fallbackOrigin) return fallbackOrigin;
    return parsed.toString();
  } catch {
    return fallbackOrigin;
  }
}

function protocolHost(req: { protocol: string; headers: { host?: string | string[] } }): string {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  return `${req.protocol}://${host || "localhost:3001"}`;
}

function getIntegrationCallbackOrigin(
  req: { protocol: string; headers: { host?: string | string[] } },
): string {
  const explicit = process.env.INTEGRATION_OAUTH_CALLBACK_ORIGIN?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return protocolHost(req);
}

export function integrationCallbackPath(provider: IntegrationProvider): string {
  return withApiPrefix(`/integrations/${provider}/callback`);
}

export function buildIntegrationCallbackUrl(
  req: { protocol: string; headers: { host?: string | string[] } },
  provider: IntegrationProvider,
): string {
  return `${getIntegrationCallbackOrigin(req)}${integrationCallbackPath(provider)}`;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Rendered when the OAuth round trip has no web page to return to -- the desktop
// app sends the user to their system browser, so the browser tab needs an
// endpoint of its own.
function renderCompletionPage(provider: IntegrationProvider, message: string, ok: boolean): string {
  const title = ok ? `${provider} connected` : `${provider} not connected`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b0c; color: #ededed;
             font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { max-width: 28rem; padding: 2rem; text-align: center; }
      h1 { font-size: 1.125rem; margin: 0 0 .5rem; }
      p { margin: 0; color: #a1a1a1; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <p>You can close this tab and return to the app.</p>
    </main>
  </body>
</html>`;
}

async function createOAuthState(
  userId: string,
  provider: IntegrationProvider,
  returnTo: string,
): Promise<string> {
  const state = randomState();
  await query(
    `INSERT INTO integration_oauth_states (state, user_id, provider, return_to, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, now(), $5)`,
    [state, userId, provider, returnTo, new Date(Date.now() + OAUTH_STATE_TTL_MS)],
  );
  // Abandoned flows would otherwise accumulate forever; this is cheap and the
  // expires_at index covers it.
  await query("DELETE FROM integration_oauth_states WHERE expires_at < now()");
  return state;
}

export async function integrationsRoutes(app: FastifyInstance) {
  // Both authorize entry points mint the same state row; one redirects, the
  // other hands the URL back for the client to open itself.
  async function startAuthorization(
    req: { auth: { id: string }; query: IntegrationAuthorizeQuery; protocol: string; headers: RequestOriginContext["headers"] },
    provider: IntegrationProvider,
  ): Promise<string> {
    const returnTo = sanitizeReturnTo(req.query.returnTo, req);
    const state = await createOAuthState(req.auth.id, provider, returnTo);
    const redirectUri = buildIntegrationCallbackUrl(req, provider);
    return getProviderClient(provider).buildAuthorizeUrl(state, redirectUri);
  }

  app.get<{ Params: { provider: string }; Querystring: IntegrationAuthorizeQuery }>(
    "/integrations/:provider/authorize",
    { preHandler: verifyAuth },
    async (req, reply) => {
      const rawProvider = req.params.provider;
      if (!isIntegrationProvider(rawProvider)) {
        return reply.code(400).send({ error: "Invalid provider" });
      }

      try {
        return reply.redirect(await startAuthorization(req, rawProvider));
      } catch (error) {
        if (isIntegrationNotConfiguredError(error)) {
          req.log.error({ provider: rawProvider, missing: error.missing }, "Integration is not configured");
          return reply.code(503).send({ error: error.reason });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { provider: string }; Querystring: IntegrationAuthorizeQuery }>(
    "/integrations/:provider/authorize-url",
    { preHandler: verifyAuth },
    async (req, reply) => {
      const rawProvider = req.params.provider;
      if (!isIntegrationProvider(rawProvider)) {
        return reply.code(400).send({ error: "Invalid provider" });
      }

      try {
        return { url: await startAuthorization(req, rawProvider) };
      } catch (error) {
        if (isIntegrationNotConfiguredError(error)) {
          req.log.error({ provider: rawProvider, missing: error.missing }, "Integration is not configured");
          return reply.code(503).send({ error: error.reason });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { provider: string }; Querystring: IntegrationCallbackQuery }>(
    "/integrations/:provider/callback",
    async (req, reply) => {
      const rawProvider = req.params.provider;
      if (!isIntegrationProvider(rawProvider)) {
        return reply.code(400).send({ error: "Invalid provider" });
      }

      const code = req.query.code?.trim();
      const state = req.query.state?.trim();
      const providerError = req.query.error?.trim();

      // Consume the state row atomically so a replayed callback cannot exchange
      // the same code twice.
      const stateResult = state
        ? await query<OAuthStateRow>(
            `DELETE FROM integration_oauth_states
              WHERE state = $1 AND provider = $2
              RETURNING user_id, provider, return_to, expires_at`,
            [state, rawProvider],
          )
        : null;
      const stateRow = stateResult?.rows[0] ?? null;

      // Everything below finishes the round trip the same way: back to the page
      // that started it, or a completion page when there is nowhere to go.
      const finish = (status: "connected" | "error", message: string) => {
        const returnTo = stateRow?.return_to ?? "";
        if (!returnTo) {
          return reply
            .code(status === "connected" ? 200 : 400)
            .type("text/html; charset=utf-8")
            .send(renderCompletionPage(rawProvider, message, status === "connected"));
        }

        let target: URL;
        try {
          target = new URL(returnTo);
        } catch {
          return reply
            .code(status === "connected" ? 200 : 400)
            .type("text/html; charset=utf-8")
            .send(renderCompletionPage(rawProvider, message, status === "connected"));
        }
        target.searchParams.set("integration", rawProvider);
        target.searchParams.set("integration_status", status);
        if (status === "error") target.searchParams.set("integration_error", message);
        return reply.code(303).redirect(target.toString());
      };

      if (providerError) {
        req.log.info({ provider: rawProvider, providerError }, "Integration authorization declined");
        return finish(
          "error",
          providerError === "access_denied"
            ? `Authorization was cancelled, so ${rawProvider} is not connected.`
            : `${rawProvider} returned "${providerError}".`,
        );
      }

      if (!state || !code) {
        return reply.code(400).send({ error: "Missing code/state" });
      }
      if (!stateRow) {
        return reply.code(400).send({ error: "Invalid OAuth state" });
      }
      if (stateRow.expires_at.getTime() <= Date.now()) {
        return finish("error", "The connection request expired. Please try connecting again.");
      }

      const client = getProviderClient(rawProvider);
      const redirectUri = buildIntegrationCallbackUrl(req, rawProvider);

      let tokens;
      try {
        tokens = await client.exchangeCode(code, redirectUri);
      } catch (error) {
        req.log.error({ provider: rawProvider, err: error }, "Integration token exchange failed");
        return finish("error", `Could not complete the ${rawProvider} connection. Please try again.`);
      }

      await query(
        `INSERT INTO user_integrations (
           user_id, provider, provider_account_id, access_token_enc, refresh_token_enc,
           token_expires_at, status, scope, connected_at, disconnected_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'connected', $7, now(), NULL, now())
         ON CONFLICT (user_id, provider) DO UPDATE SET
           provider_account_id = EXCLUDED.provider_account_id,
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, user_integrations.refresh_token_enc),
           token_expires_at = EXCLUDED.token_expires_at,
           scope = EXCLUDED.scope,
           status = 'connected',
           connected_at = now(),
           disconnected_at = NULL,
           updated_at = now()`,
        [
          stateRow.user_id,
          rawProvider,
          tokens.providerAccountId,
          encryptToken(tokens.accessToken),
          tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
          tokens.expiresAt,
          tokens.scope,
        ],
      );

      return finish("connected", `${rawProvider} is connected.`);
    },
  );

  app.get<{ Params: { provider: string } }>(
    "/integrations/:provider/status",
    { preHandler: verifyAuth },
    async (req, reply) => {
      const rawProvider = req.params.provider;
      if (!isIntegrationProvider(rawProvider)) {
        return reply.code(400).send({ error: "Invalid provider" });
      }

      const result = await query<UserIntegrationStatusRow>(
        `SELECT status, refresh_token_enc, token_expires_at
         FROM user_integrations
         WHERE user_id = $1 AND provider = $2`,
        [req.auth.id, rawProvider],
      );

      const configured = getProviderClient(rawProvider).isConfigured();
      if (result.rowCount === 0) {
        return { provider: rawProvider, status: "disconnected", configured };
      }

      const row = result.rows[0];
      return {
        provider: rawProvider,
        status: resolveIntegrationStatus(row.status, row.token_expires_at, Boolean(row.refresh_token_enc)),
        configured,
      };
    },
  );

  app.post<{ Params: { provider: string } }>(
    "/integrations/:provider/disconnect",
    { preHandler: verifyAuth },
    async (req, reply) => {
      const rawProvider = req.params.provider;
      if (!isIntegrationProvider(rawProvider)) {
        return reply.code(400).send({ error: "Invalid provider" });
      }

      const tokenResult = await query<TokenRow>(
        "SELECT access_token_enc, refresh_token_enc FROM user_integrations WHERE user_id = $1 AND provider = $2",
        [req.auth.id, rawProvider],
      );

      if ((tokenResult.rowCount ?? 0) > 0) {
        const client = getProviderClient(rawProvider);
        try {
          const accessRow = tokenResult.rows[0];
          if (accessRow.access_token_enc) {
            const accessToken = decryptToken(accessRow.access_token_enc);
            await client.revokeToken(accessToken);
          }
          if (accessRow.refresh_token_enc) {
            const refreshToken = decryptToken(accessRow.refresh_token_enc);
            await client.revokeToken(refreshToken);
          }
        } catch (error) {
          req.log.warn({ provider: rawProvider, err: error }, "Integration token revocation failed");
        }

        await query(
          `UPDATE user_integrations
           SET status = 'disconnected',
               access_token_enc = '',
               refresh_token_enc = NULL,
               token_expires_at = NULL,
               disconnected_at = now(),
               updated_at = now()
           WHERE user_id = $1 AND provider = $2`,
          [req.auth.id, rawProvider],
        );
      }

      return { provider: rawProvider, status: "disconnected" };
    },
  );
}
