import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { withApiPrefix } from "../api-prefix.js";
import { query } from "../db.js";
import { verifyAuth } from "../auth.js";
import { decryptToken, encryptToken } from "../integrations/crypto.js";
import {
  getProviderClient,
  isIntegrationProvider,
  type IntegrationProvider,
} from "../integrations/index.js";

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
}

interface RequestOriginContext {
  protocol: string;
  headers: { host?: string | string[]; origin?: string | string[]; referer?: string | string[] };
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function getIntegrationFrontendOrigin(
  req: RequestOriginContext,
): string {
  const explicit = process.env.INTEGRATION_CALLBACK_ORIGIN?.trim();
  if (explicit) return explicit;

  const headerOrigin = firstHeaderValue(req.headers.origin);
  if (headerOrigin) return headerOrigin;

  const referer = firstHeaderValue(req.headers.referer);
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      // Ignore invalid referer value.
    }
  }

  return protocolHost(req);
}

function randomState(): string {
  return randomBytes(24).toString("hex");
}

function sanitizeReturnTo(
  raw: string | undefined,
  req: RequestOriginContext,
): string {
  const fallbackOrigin = getIntegrationFrontendOrigin(req);
  if (!raw) return fallbackOrigin;
  if (raw.length > 1024) return fallbackOrigin;

  if (raw.startsWith("/")) {
    return new URL(raw, fallbackOrigin).toString();
  }

  try {
    const parsed = new URL(raw);
    const parsedFallbackOrigin = new URL(fallbackOrigin).origin;
    if (parsed.origin !== parsedFallbackOrigin) {
      return fallbackOrigin;
    }
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

function integrationStatusValue(
  status: string,
  tokenExpiresAt: Date | null,
  hasRefreshToken: boolean,
): "connected" | "disconnected" | "expired" | "needs_reauth" {
  if (status === "disconnected") return "disconnected";
  if (status === "needs_reauth") return "needs_reauth";
  if (status === "expired") return "expired";
  if (status === "connected" && tokenExpiresAt && tokenExpiresAt.getTime() <= Date.now()) {
    return hasRefreshToken ? "needs_reauth" : "expired";
  }
  return "connected";
}

export async function integrationsRoutes(app: FastifyInstance) {
  app.get<{ Params: { provider: string }; Querystring: IntegrationAuthorizeQuery }>(
    "/integrations/:provider/authorize",
    { preHandler: verifyAuth },
    async (req, reply) => {
      const rawProvider = req.params.provider;
      if (!isIntegrationProvider(rawProvider)) {
        return reply.code(400).send({ error: "Invalid provider" });
      }

      const returnTo = sanitizeReturnTo(req.query.returnTo, req);
      const state = randomState();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const redirectUri = buildIntegrationCallbackUrl(req, rawProvider);

      await query(
        `INSERT INTO integration_oauth_states (state, user_id, provider, return_to, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, now(), $5)`,
        [state, req.auth.id, rawProvider, returnTo, expiresAt],
      );

      const client = getProviderClient(rawProvider);
      const authorizeUrl = await client.buildAuthorizeUrl(state, redirectUri);
      return reply.redirect(authorizeUrl);
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

      const returnTo = sanitizeReturnTo(req.query.returnTo, req);
      const state = randomState();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const redirectUri = buildIntegrationCallbackUrl(req, rawProvider);

      await query(
        `INSERT INTO integration_oauth_states (state, user_id, provider, return_to, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, now(), $5)`,
        [state, req.auth.id, rawProvider, returnTo, expiresAt],
      );

      const client = getProviderClient(rawProvider);
      const authorizeUrl = await client.buildAuthorizeUrl(state, redirectUri);
      return { url: authorizeUrl };
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
      if (!code || !state) {
        return reply.code(400).send({ error: "Missing code/state" });
      }

      const stateResult = await query<OAuthStateRow>(
        `SELECT user_id, provider, return_to, expires_at
         FROM integration_oauth_states
         WHERE state = $1 AND provider = $2`,
        [state, rawProvider],
      );

      if (stateResult.rowCount === 0) {
        return reply.code(400).send({ error: "Invalid OAuth state" });
      }

      const stateRow = stateResult.rows[0];
      if (stateRow.expires_at.getTime() <= Date.now()) {
        await query("DELETE FROM integration_oauth_states WHERE state = $1", [state]);
        return reply.code(400).send({ error: "OAuth state expired" });
      }

      const client = getProviderClient(rawProvider);
      const redirectUri = buildIntegrationCallbackUrl(req, rawProvider);
      const tokens = await client.exchangeCode(code, redirectUri);

      await query(
        `INSERT INTO user_integrations (
           user_id, provider, provider_account_id, access_token_enc, refresh_token_enc,
           token_expires_at, status, scope, connected_at, disconnected_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'connected', $7, now(), NULL, now())
         ON CONFLICT (user_id, provider) DO UPDATE SET
           provider_account_id = EXCLUDED.provider_account_id,
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = EXCLUDED.refresh_token_enc,
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

      await query("DELETE FROM integration_oauth_states WHERE state = $1", [state]);

      const rawReturnTo = stateRow.return_to;
      const returnTo =
        rawReturnTo.startsWith("http://") || rawReturnTo.startsWith("https://")
          ? new URL(rawReturnTo)
          : new URL(rawReturnTo, getIntegrationFrontendOrigin(req));
      returnTo.searchParams.set("integration", rawProvider);
      returnTo.searchParams.set("integration_status", "connected");
      return reply.code(303).redirect(returnTo.toString());
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

      if (result.rowCount === 0) {
        return { provider: rawProvider, status: "disconnected" };
      }

      const row = result.rows[0];
      const hasRefresh = Boolean(row.refresh_token_enc);
      return {
        provider: rawProvider,
        status: integrationStatusValue(row.status, row.token_expires_at, hasRefresh),
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
        } catch {
          // best effort revoke
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
