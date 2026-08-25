import {
  createIntegrationNotConfiguredError,
  createInvalidSourceUrlError,
  createProviderApiError,
} from "./errors.js";

export type GoogleAuthScope = string;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_DOC_URL_PREFIX = "https://docs.google.com/document/";
const GOOGLE_DOCS_API_URL = "https://docs.googleapis.com/v1/documents";

export interface ExternalTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  tokenType: string;
  scope: string | null;
  providerAccountId: string | null;
}

export interface ExternalDocumentResult {
  sourceExternalId: string;
  sourceUrl: string;
  title: string;
  text: string;
  sourceMetadata: Record<string, unknown>;
}

export interface SourceLookupResult {
  sourceExternalId: string;
  sourceUrl: string;
}

interface GoogleDocResponse {
  title?: string;
  documentId?: string;
  revisionId?: string;
  body?: { content?: Array<unknown> };
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw createIntegrationNotConfiguredError("google", name);
  }
  return value;
}

function requireGoogleConfig() {
  return {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    defaultScope: process.env.GOOGLE_OAUTH_SCOPE?.trim()
      || "https://www.googleapis.com/auth/documents.readonly",
  };
}

export function isGoogleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function extractDocumentIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl.trim());
    if (url.hostname.toLowerCase() !== "docs.google.com") return null;
    // Published documents use /document/d/e/<publish-id>/pub, which the Docs API
    // cannot resolve -- treat them as unsupported rather than requesting "e".
    if (/\/document\/d\/e\//.test(url.pathname)) return null;
    const match = url.pathname.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function requireDocumentId(rawUrl: string): string {
  const documentId = extractDocumentIdFromUrl(rawUrl);
  if (!documentId) {
    throw createInvalidSourceUrlError(
      "google",
      "That is not a Google Docs document URL. Copy the link from the document itself, for example https://docs.google.com/document/d/<id>/edit.",
    );
  }
  return documentId.trim();
}

function buildSourceUrl(documentId: string): string {
  return `${GOOGLE_DOC_URL_PREFIX}d/${documentId}/edit`;
}

// Walks the Docs structural elements once, appending one entry per paragraph.
// Table cells carry their own `content` array, so they recurse through here too
// rather than through a second traversal that would emit their text twice.
function collectText(node: unknown, output: string[]): void {
  if (!node || typeof node !== "object") return;
  const typed = node as Record<string, unknown>;

  if (typed.paragraph && typeof typed.paragraph === "object") {
    const paragraph = typed.paragraph as Record<string, unknown>;
    const elements = Array.isArray(paragraph.elements) ? paragraph.elements : [];
    let line = "";
    for (const element of elements) {
      if (!element || typeof element !== "object") continue;
      const child = element as Record<string, unknown>;
      const textRun = child.textRun as { content?: string } | undefined;
      if (typeof textRun?.content === "string") {
        line += textRun.content;
      }
    }
    if (line.trim()) output.push(line.replace(/\n+$/u, ""));
    return;
  }

  if (typed.table && typeof typed.table === "object") {
    const table = typed.table as Record<string, unknown>;
    const rows = Array.isArray(table.tableRows) ? table.tableRows : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const cells = (row as Record<string, unknown>).tableCells;
      if (!Array.isArray(cells)) continue;
      for (const cell of cells) {
        collectContent(cell, output);
      }
    }
    return;
  }

  if (typed.tableOfContents && typeof typed.tableOfContents === "object") {
    collectContent(typed.tableOfContents, output);
    return;
  }

  if (Array.isArray(typed.content)) {
    collectContent(typed, output);
  }
}

function collectContent(node: unknown, output: string[]): void {
  if (!node || typeof node !== "object") return;
  const content = (node as Record<string, unknown>).content;
  if (!Array.isArray(content)) return;
  for (const child of content) {
    collectText(child, output);
  }
}

function buildPlainTextFromDocument(document: GoogleDocResponse): string {
  const output: string[] = [];
  const content = Array.isArray(document.body?.content) ? document.body.content : [];
  for (const node of content) {
    collectText(node, output);
  }
  return output.join("\n\n").trim();
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) return "";
    const parsed = JSON.parse(trimmed) as { error?: { message?: string } | string; error_description?: string };
    if (typeof parsed.error === "object" && typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.error === "string") {
      return parsed.error_description ? `${parsed.error}: ${parsed.error_description}` : parsed.error;
    }
    return trimmed.slice(0, 500);
  } catch {
    return "";
  }
}

function buildGoogleApiErrorReason(status: number, responseBody: string): string {
  if (status === 401) {
    return "Google rejected the stored credentials. Reconnect Google Docs and try again.";
  }
  if (status === 403) {
    return "The connected Google account cannot open this document. Ask the owner to share it, then try again.";
  }
  if (status === 404) {
    return "That Google document does not exist, or the connected Google account cannot see it.";
  }
  if (status === 429) {
    return "Google rate limit reached. Please retry shortly.";
  }
  if (status >= 500) {
    return "Google Docs is unavailable right now. Please retry shortly.";
  }
  return responseBody
    ? `Unable to fetch the Google document: ${responseBody}`
    : "Unable to fetch the Google document due to an external API error.";
}

async function requestGoogleToken(payload: Record<string, string>): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = requireGoogleConfig();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      ...payload,
    }).toString(),
  });

  if (!response.ok) {
    const responseBody = await readErrorBody(response);
    throw createProviderApiError("google", {
      status: response.status,
      statusText: response.statusText,
      reason: responseBody
        ? `Google rejected the token request: ${responseBody}`
        : "Google rejected the token request.",
      responseBody,
      requestUrl: GOOGLE_TOKEN_URL,
    });
  }

  return (await response.json().catch(() => ({}))) as GoogleTokenResponse;
}

export async function buildAuthorizeUrl(state: string, redirectUri: string, scope?: string) {
  const { clientId, defaultScope } = requireGoogleConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: scope ?? defaultScope,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<ExternalTokenResult> {
  const result = await requestGoogleToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  if (!result.access_token) throw new Error("Google token exchange missing access token");

  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    expiresAt: result.expires_in ? new Date(Date.now() + result.expires_in * 1000).toISOString() : null,
    tokenType: result.token_type ?? "Bearer",
    scope: result.scope ?? null,
    providerAccountId: null,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<ExternalTokenResult> {
  const result = await requestGoogleToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  if (!result.access_token) throw new Error("Google token refresh missing access token");

  return {
    accessToken: result.access_token,
    // Google only returns a refresh token on the first consent, so keep the one
    // we already hold when the response omits it.
    refreshToken: result.refresh_token ?? refreshToken,
    expiresAt: result.expires_in ? new Date(Date.now() + result.expires_in * 1000).toISOString() : null,
    tokenType: result.token_type ?? "Bearer",
    scope: result.scope ?? null,
    providerAccountId: null,
  };
}

export async function revokeAccessToken(token: string): Promise<void> {
  await fetch(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

export async function fetchDocumentByUrl(sourceUrl: string, accessToken: string): Promise<ExternalDocumentResult> {
  const documentId = requireDocumentId(sourceUrl);
  const requestUrl = `${GOOGLE_DOCS_API_URL}/${encodeURIComponent(documentId)}`;
  const response = await fetch(requestUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const responseBody = await readErrorBody(response);
    throw createProviderApiError("google", {
      status: response.status,
      statusText: response.statusText,
      reason: buildGoogleApiErrorReason(response.status, responseBody),
      responseBody,
      requestUrl,
    });
  }

  const doc = (await response.json()) as GoogleDocResponse;
  const plainText = buildPlainTextFromDocument(doc);
  const title = doc.title?.trim() || "Google Document";
  const sourceUrlValue = buildSourceUrl(documentId);
  const text = plainText || "Imported from Google Docs.";

  return {
    sourceExternalId: documentId,
    sourceUrl: sourceUrlValue,
    title,
    text,
    sourceMetadata: {
      provider: "google",
      documentId,
      sourceUrl: sourceUrlValue,
      title,
      revisionId: doc.revisionId ?? null,
    },
  };
}

export function parseSourceUrl(sourceUrl: string): SourceLookupResult {
  const documentId = requireDocumentId(sourceUrl);
  return {
    sourceExternalId: documentId,
    sourceUrl: buildSourceUrl(documentId),
  };
}
