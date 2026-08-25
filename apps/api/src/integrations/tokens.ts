import { query } from "../db.js";
import { decryptToken, encryptToken } from "./crypto.js";
import { isIntegrationNotConfiguredError } from "./errors.js";
import { getProviderClient, sourceTypeToProvider, type DocSourceType, type IntegrationProvider } from "./index.js";

export type IntegrationReconnectStatus = "disconnected" | "needs_reauth";

// Refresh slightly before the recorded expiry so a token that is about to lapse
// mid-request is renewed instead of being sent and rejected.
const EXPIRY_SKEW_MS = 60_000;

export interface IntegrationReconnectError extends Error {
  code: "INTEGRATION_RECONNECT";
  provider: IntegrationProvider;
  status: IntegrationReconnectStatus;
}

interface UserIntegrationRow {
  status: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: Date | null;
}

export function isIntegrationReconnectError(value: unknown): value is IntegrationReconnectError {
  return typeof value === "object"
    && value !== null
    && (value as { code?: string }).code === "INTEGRATION_RECONNECT";
}

function createIntegrationReconnectError(
  provider: IntegrationProvider,
  status: IntegrationReconnectStatus,
): IntegrationReconnectError {
  const error = new Error(`Integration ${provider} requires reconnect`) as IntegrationReconnectError;
  error.code = "INTEGRATION_RECONNECT";
  error.provider = provider;
  error.status = status;
  return error;
}

async function markIntegrationNeedsReauth(userId: string, provider: IntegrationProvider): Promise<void> {
  await query(
    `UPDATE user_integrations
        SET status = 'needs_reauth', updated_at = now()
      WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
}

// Returns a usable access token, refreshing it first if it has expired. Every
// path that cannot produce one throws an IntegrationReconnectError carrying the
// provider and why, so callers can answer 409 and the UI can prompt a reconnect
// instead of showing a generic failure.
export async function getIntegrationAccessToken(
  userId: string,
  sourceType: Exclude<DocSourceType, "local">,
): Promise<string> {
  const provider = sourceTypeToProvider(sourceType);
  const result = await query<UserIntegrationRow>(
    `SELECT status, access_token_enc, refresh_token_enc, token_expires_at
       FROM user_integrations
      WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );

  const row = result.rows[0];
  if (!row || row.status === "disconnected") {
    throw createIntegrationReconnectError(provider, "disconnected");
  }
  if (row.status === "needs_reauth" || !row.access_token_enc) {
    throw createIntegrationReconnectError(provider, "needs_reauth");
  }

  const isExpired = row.token_expires_at instanceof Date
    ? row.token_expires_at.getTime() - EXPIRY_SKEW_MS <= Date.now()
    : false;
  if (!isExpired) {
    return decryptToken(row.access_token_enc);
  }

  if (!row.refresh_token_enc) {
    await markIntegrationNeedsReauth(userId, provider);
    throw createIntegrationReconnectError(provider, "needs_reauth");
  }

  try {
    const refresh = await getProviderClient(provider).refreshAccessToken(decryptToken(row.refresh_token_enc));
    await query(
      `UPDATE user_integrations
          SET access_token_enc = $3,
              refresh_token_enc = COALESCE($4, refresh_token_enc),
              token_expires_at = $5,
              status = 'connected',
              updated_at = now(),
              disconnected_at = NULL
        WHERE user_id = $1 AND provider = $2`,
      [
        userId,
        provider,
        encryptToken(refresh.accessToken),
        refresh.refreshToken ? encryptToken(refresh.refreshToken) : null,
        refresh.expiresAt,
      ],
    );
    return refresh.accessToken;
  } catch (error) {
    // A server misconfiguration is not the user's credentials going bad, so
    // surface it rather than burning the stored connection.
    if (isIntegrationNotConfiguredError(error)) throw error;
    await markIntegrationNeedsReauth(userId, provider);
    throw createIntegrationReconnectError(provider, "needs_reauth");
  }
}

// Fetches a document from the provider the source type names, translating the
// caller's URL through the provider's own parser first.
export async function fetchRemoteDocument(
  userId: string,
  sourceType: Exclude<DocSourceType, "local">,
  sourceUrl: string,
) {
  const client = getProviderClient(sourceTypeToProvider(sourceType));
  const parsed = client.parseSourceUrl(sourceUrl);
  const accessToken = await getIntegrationAccessToken(userId, sourceType);
  return client.fetchDocument(parsed.sourceUrl, accessToken);
}
