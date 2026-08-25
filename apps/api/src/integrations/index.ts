import {
  buildAuthorizeUrl as buildGoogleAuthorizeUrl,
  exchangeCodeForTokens as exchangeGoogleCodeForTokens,
  fetchDocumentByUrl as fetchGoogleDocumentByUrl,
  parseSourceUrl as parseGoogleSourceUrl,
  refreshAccessToken as refreshGoogleAccessToken,
  isGoogleConfigured,
  type ExternalDocumentResult as ExternalGoogleDocumentResult,
  type ExternalTokenResult as ExternalGoogleTokenResult,
  revokeAccessToken as revokeGoogleAccessToken,
} from "./google.js";
import {
  buildAuthorizeUrl as buildNotionAuthorizeUrl,
  exchangeCodeForTokens as exchangeNotionCodeForTokens,
  fetchDocumentByUrl as fetchNotionDocumentByUrl,
  parseSourceUrl as parseNotionSourceUrl,
  refreshAccessToken as refreshNotionAccessToken,
  isNotionConfigured,
  type ExternalDocumentResult as ExternalNotionDocumentResult,
  type ExternalTokenResult as ExternalNotionTokenResult,
  revokeAccessToken as revokeNotionAccessToken,
} from "./notion.js";

export type IntegrationProvider = "notion" | "google";
export type DocSourceType = "local" | "notion" | "google_doc";

export interface IntegrationTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
  providerAccountId: string | null;
}

export interface ExternalDocumentImportResult {
  sourceType: DocSourceType;
  sourceExternalId: string;
  sourceUrl: string;
  title: string;
  text: string;
  sourceMetadata: Record<string, unknown>;
}

export interface SourceParseResult {
  sourceExternalId: string;
  sourceUrl: string;
}

export type IntegrationStatus = "connected" | "disconnected" | "expired" | "needs_reauth";

export interface IntegrationProviderClient {
  provider: IntegrationProvider;
  isConfigured(): boolean;
  buildAuthorizeUrl(state: string, redirectUri: string): Promise<string>;
  exchangeCode(code: string, redirectUri: string): Promise<IntegrationTokenResult>;
  refreshAccessToken(refreshToken: string): Promise<IntegrationTokenResult>;
  fetchDocument(sourceUrl: string, accessToken: string): Promise<ExternalDocumentImportResult>;
  parseSourceUrl(sourceUrl: string): SourceParseResult;
  revokeToken(token: string): Promise<void>;
}

function toTokenResult(result: ExternalGoogleTokenResult | ExternalNotionTokenResult): IntegrationTokenResult {
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
    scope: result.scope,
    providerAccountId: result.providerAccountId,
  };
}

function toImportResult(
  sourceType: DocSourceType,
  result: ExternalGoogleDocumentResult | ExternalNotionDocumentResult,
): ExternalDocumentImportResult {
  return {
    sourceType,
    sourceExternalId: result.sourceExternalId,
    sourceUrl: result.sourceUrl,
    title: result.title,
    text: result.text,
    sourceMetadata: result.sourceMetadata,
  };
}

const googleClient: IntegrationProviderClient = {
  provider: "google",
  isConfigured: isGoogleConfigured,
  async buildAuthorizeUrl(state, redirectUri) {
    return buildGoogleAuthorizeUrl(state, redirectUri);
  },
  async exchangeCode(code, redirectUri) {
    return toTokenResult(await exchangeGoogleCodeForTokens(code, redirectUri));
  },
  async refreshAccessToken(refreshToken) {
    return toTokenResult(await refreshGoogleAccessToken(refreshToken));
  },
  async fetchDocument(sourceUrl, accessToken) {
    return toImportResult("google_doc", await fetchGoogleDocumentByUrl(sourceUrl, accessToken));
  },
  parseSourceUrl(sourceUrl) {
    return parseGoogleSourceUrl(sourceUrl);
  },
  async revokeToken(token) {
    await revokeGoogleAccessToken(token);
  },
};

const notionClient: IntegrationProviderClient = {
  provider: "notion",
  isConfigured: isNotionConfigured,
  async buildAuthorizeUrl(state, redirectUri) {
    return buildNotionAuthorizeUrl(state, redirectUri);
  },
  async exchangeCode(code, redirectUri) {
    return toTokenResult(await exchangeNotionCodeForTokens(code, redirectUri));
  },
  async refreshAccessToken(refreshToken) {
    return toTokenResult(await refreshNotionAccessToken(refreshToken));
  },
  async fetchDocument(sourceUrl, accessToken) {
    return toImportResult("notion", await fetchNotionDocumentByUrl(sourceUrl, accessToken));
  },
  parseSourceUrl(sourceUrl) {
    return parseNotionSourceUrl(sourceUrl);
  },
  async revokeToken(token) {
    await revokeNotionAccessToken(token);
  },
};

const PROVIDERS: Record<IntegrationProvider, IntegrationProviderClient> = {
  notion: notionClient,
  google: googleClient,
};

export function isIntegrationProvider(value: string): value is IntegrationProvider {
  return value === "notion" || value === "google";
}

export function getProviderClient(provider: IntegrationProvider): IntegrationProviderClient {
  return PROVIDERS[provider];
}

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = ["notion", "google"];

// A stored row says what we last saw; the live answer also depends on whether
// the access token has aged out. A row that carries a refresh token stays
// "connected" past expiry because the next call refreshes it transparently --
// only a row with nothing left to refresh with needs the user back.
export function resolveIntegrationStatus(
  storedStatus: string,
  tokenExpiresAt: Date | null,
  hasRefreshToken: boolean,
): IntegrationStatus {
  if (storedStatus === "disconnected") return "disconnected";
  if (storedStatus === "needs_reauth") return "needs_reauth";
  if (storedStatus === "expired") return "expired";
  if (storedStatus !== "connected") return "disconnected";
  if (tokenExpiresAt && tokenExpiresAt.getTime() <= Date.now() && !hasRefreshToken) {
    return "expired";
  }
  return "connected";
}

export function sourceTypeToProvider(sourceType: Exclude<DocSourceType, "local">): IntegrationProvider {
  return sourceType === "google_doc" ? "google" : "notion";
}
