import {
  createIntegrationNotConfiguredError,
  createInvalidSourceUrlError,
  createProviderApiError,
  isProviderApiError,
  type ProviderApiError,
} from "./errors.js";

const NOTION_AUTH_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_REVOKE_URL = "https://api.notion.com/v1/oauth/revoke";
const NOTION_PAGE_URL = "https://api.notion.com/v1/pages";
const NOTION_BLOCKS_URL = "https://api.notion.com/v1/blocks";
const NOTION_VERSION = "2022-06-28";

// Bounds on how much of a page we pull: Notion pages nest arbitrarily deep and
// each level costs a request, so cap both the block budget and the depth.
const MAX_BLOCKS = 400;
const MAX_DEPTH = 3;
const BLOCK_PAGE_SIZE = 100;

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

interface NotionTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  owner?: {
    user?: { id?: string };
  };
}

interface NotionPageResponse {
  id?: string;
  url?: string;
  properties?: Record<string, unknown>;
}

interface NotionRichText {
  plain_text?: string;
}

interface NotionBlock {
  id?: string;
  type?: string;
  has_children?: boolean;
  [key: string]: unknown;
}

interface NotionBlockListResponse {
  results?: NotionBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export type NotionApiError = ProviderApiError;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw createIntegrationNotConfiguredError("notion", name);
  return value;
}

function requireNotionConfig() {
  return {
    clientId: env("NOTION_CLIENT_ID"),
    clientSecret: env("NOTION_CLIENT_SECRET"),
  };
}

export function isNotionConfigured(): boolean {
  return Boolean(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET);
}

function notionClientAuthHeaders(): Record<string, string> {
  const { clientId, clientSecret } = requireNotionConfig();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    "Notion-Version": NOTION_VERSION,
  };
}

function extractNotionIdFromText(value: string): string | null {
  const uuidMatch = value.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  );
  if (uuidMatch) {
    return uuidMatch[0].replace(/-/g, "").toLowerCase();
  }

  const plainMatch = value.match(/[0-9a-fA-F]{32}/);
  return plainMatch ? plainMatch[0].toLowerCase() : null;
}

function extractNotionPageId(rawUrl: string): string | null {
  try {
    const candidateSource = rawUrl.trim();
    const url = new URL(candidateSource);
    const host = url.hostname.toLowerCase();
    if (!host.endsWith("notion.so") && !host.endsWith("notion.site") && !host.endsWith("notion.com")) return null;

    const candidates = [
      // The page id is the trailing token of the path; `p` takes precedence over
      // `v` (a database view id) when both are present in the query string.
      ...url.pathname.split("/").filter(Boolean).reverse(),
      url.searchParams.get("p") ?? "",
      ...Array.from(url.searchParams.values()),
      candidateSource,
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const normalizedCandidate = extractNotionIdFromText(candidate);
      if (normalizedCandidate) {
        return normalizedCandidate;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function buildSourceUrl(sourceId: string): string {
  return `https://www.notion.so/${sourceId.replace(/-/g, "")}`;
}

function extractTitleFromProperties(properties: Record<string, unknown>): string | null {
  const values = Object.values(properties);
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const item = value as { type?: string; title?: NotionRichText[]; rich_text?: NotionRichText[] };
    if (item.type === "title" && Array.isArray(item.title)) {
      const title = item.title.map((entry) => entry?.plain_text ?? "").join("");
      if (title.trim()) return title.trim();
    }
    if (item.type === "rich_text" && Array.isArray(item.rich_text)) {
      const title = item.rich_text.map((entry) => entry?.plain_text ?? "").join("");
      if (title.trim()) return title.trim();
    }
  }
  return null;
}

function richTextToPlain(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return (value as NotionRichText[]).map((entry) => entry?.plain_text ?? "").join("");
}

// Renders one block as a markdown-ish line. Returns null for blocks that carry
// no text of their own (a column layout, an unsupported embed) so the caller can
// still descend into their children.
function renderBlock(block: NotionBlock, depth: number): string | null {
  const type = block.type;
  if (!type) return null;
  const payload = block[type];
  const data = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const text = richTextToPlain(data.rich_text);
  const indent = "  ".repeat(Math.max(0, depth));

  switch (type) {
    case "paragraph":
      return text.trim() ? text.trim() : null;
    case "heading_1":
      return text.trim() ? `# ${text.trim()}` : null;
    case "heading_2":
      return text.trim() ? `## ${text.trim()}` : null;
    case "heading_3":
      return text.trim() ? `### ${text.trim()}` : null;
    case "bulleted_list_item":
    case "toggle":
      return text.trim() ? `${indent}- ${text.trim()}` : null;
    case "numbered_list_item":
      return text.trim() ? `${indent}1. ${text.trim()}` : null;
    case "to_do":
      return text.trim() ? `${indent}- [${data.checked === true ? "x" : " "}] ${text.trim()}` : null;
    case "quote":
      return text.trim() ? `> ${text.trim()}` : null;
    case "callout":
      return text.trim() ? `> ${text.trim()}` : null;
    case "code": {
      if (!text.trim()) return null;
      const language = typeof data.language === "string" ? data.language : "";
      return `\`\`\`${language}\n${text}\n\`\`\``;
    }
    case "divider":
      return "---";
    case "child_page":
      return typeof data.title === "string" && data.title.trim() ? `## ${data.title.trim()}` : null;
    case "table_row": {
      const cells = Array.isArray(data.cells) ? data.cells : [];
      const rendered = cells.map((cell) => richTextToPlain(cell).trim());
      return rendered.some((cell) => cell) ? `| ${rendered.join(" | ")} |` : null;
    }
    case "bookmark":
    case "embed":
    case "link_preview":
      return typeof data.url === "string" && data.url.trim() ? data.url.trim() : null;
    case "image":
    case "video":
    case "file":
    case "pdf": {
      const caption = richTextToPlain(data.caption).trim();
      return caption ? `(${type}: ${caption})` : null;
    }
    default:
      return text.trim() ? text.trim() : null;
  }
}

async function notionApiRequest<T>(url: string, accessToken: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const responseBody = await parseNotionApiErrorBody(response);
    throw createProviderApiError("notion", {
      status: response.status,
      statusText: response.statusText,
      reason: buildNotionApiErrorReason(response.status, responseBody),
      responseBody,
      requestUrl: url,
    });
  }

  return (await response.json()) as T;
}

async function parseNotionApiErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return parseNotionErrorText(text);
  } catch {
    return "";
  }
}

function parseNotionErrorText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message = parsed.message;
    const reason = Array.isArray(message)
      ? message.join(", ")
      : typeof message === "string"
        ? message
        : typeof parsed.error === "string"
          ? parsed.error
          : "";
    return reason || trimmed.slice(0, 500);
  } catch {
    return trimmed.slice(0, 500);
  }
}

function buildNotionApiErrorReason(status: number, responseBody?: string): string {
  if (status === 401) {
    return "Notion token is unauthorized. Reconnect your Notion integration.";
  }
  if (status === 403) {
    return "Notion integration lacks permission to access this page. Share the page with your integration and try again.";
  }
  if (status === 404) {
    if (responseBody) {
      return `Notion page not found or inaccessible to the connected workspace. Verify the page exists and is shared with your Notion integration. Notion response: ${responseBody}`;
    }
    return "Notion page not found or inaccessible to the connected workspace. Verify the page exists and is shared with your Notion integration.";
  }
  if (status === 429) {
    return "Notion API rate limit reached. Please retry shortly.";
  }
  return "Unable to fetch the Notion page due to an external API error.";
}

async function requestNotionToken(payload: Record<string, string>): Promise<NotionTokenResponse> {
  const response = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...notionClientAuthHeaders(),
    },
    body: JSON.stringify(payload),
  });

  // Read the body once -- the error path and the success path cannot both
  // consume the stream.
  const rawBody = await response.text().catch(() => "");
  if (!response.ok) {
    const responseBody = parseNotionErrorText(rawBody);
    throw createProviderApiError("notion", {
      status: response.status,
      statusText: response.statusText,
      reason: responseBody
        ? `Notion rejected the token request: ${responseBody}`
        : "Notion rejected the token request.",
      responseBody,
      requestUrl: NOTION_TOKEN_URL,
    });
  }

  try {
    return JSON.parse(rawBody) as NotionTokenResponse;
  } catch {
    return {};
  }
}

async function requestNotionTokenRevocation(accessToken: string) {
  const response = await fetch(NOTION_REVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...notionClientAuthHeaders(),
    },
    body: JSON.stringify({ token: accessToken }),
  });
  if (!response.ok) {
    throw new Error(`Notion revoke request failed: ${response.status}`);
  }
}

export async function buildAuthorizeUrl(state: string, redirectUri: string): Promise<string> {
  const { clientId } = requireNotionConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    owner: "user",
    state,
  });
  // Notion derives capabilities from the integration's settings; only send a
  // scope when one is explicitly configured.
  const scope = process.env.NOTION_OAUTH_SCOPE?.trim();
  if (scope) params.set("scope", scope);
  return `${NOTION_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<ExternalTokenResult> {
  const result = await requestNotionToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  if (!result.access_token) {
    throw new Error("Notion token exchange missing access token");
  }

  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    expiresAt: result.expires_in ? new Date(Date.now() + result.expires_in * 1000).toISOString() : null,
    tokenType: result.token_type ?? "Bearer",
    scope: result.scope ?? null,
    providerAccountId: result.owner?.user?.id ?? null,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<ExternalTokenResult> {
  const result = await requestNotionToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  if (!result.access_token) {
    throw new Error("Notion token refresh missing access token");
  }

  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? refreshToken,
    expiresAt: result.expires_in ? new Date(Date.now() + result.expires_in * 1000).toISOString() : null,
    tokenType: result.token_type ?? "Bearer",
    scope: result.scope ?? null,
    providerAccountId: result.owner?.user?.id ?? null,
  };
}

// Walks a block subtree breadth-first within MAX_BLOCKS/MAX_DEPTH, following
// Notion's cursor pagination so long pages import in full rather than being
// silently cut off at the first page of children.
async function collectBlockLines(
  blockId: string,
  accessToken: string,
  lines: string[],
  depth: number,
  budget: { remaining: number },
): Promise<void> {
  if (depth > MAX_DEPTH || budget.remaining <= 0) return;

  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ page_size: String(BLOCK_PAGE_SIZE) });
    if (cursor) params.set("start_cursor", cursor);
    const result: NotionBlockListResponse = await notionApiRequest<NotionBlockListResponse>(
      `${NOTION_BLOCKS_URL}/${encodeURIComponent(blockId)}/children?${params.toString()}`,
      accessToken,
    );

    for (const block of result.results ?? []) {
      if (budget.remaining <= 0) return;
      budget.remaining -= 1;

      const line = renderBlock(block, depth);
      if (line) lines.push(line);

      if (block.has_children && block.id && block.type !== "child_page" && block.type !== "child_database") {
        await collectBlockLines(block.id, accessToken, lines, depth + 1, budget);
      }
    }

    cursor = result.has_more ? (result.next_cursor ?? null) : null;
  } while (cursor && budget.remaining > 0);
}

export async function fetchDocumentByUrl(sourceUrl: string, accessToken: string): Promise<ExternalDocumentResult> {
  const sourceLookup = parseSourceUrl(sourceUrl);
  const page = await notionApiRequest<NotionPageResponse>(
    `${NOTION_PAGE_URL}/${encodeURIComponent(sourceLookup.sourceExternalId)}`,
    accessToken,
  );

  const properties = (page.properties ?? {}) as Record<string, unknown>;
  const title = extractTitleFromProperties(properties) ?? "Notion Page";

  const lines: string[] = [];
  await collectBlockLines(sourceLookup.sourceExternalId, accessToken, lines, 0, { remaining: MAX_BLOCKS });
  const body = lines.join("\n").trim();
  const text = body ? `# ${title}\n\n${body}` : `Notion page: ${title}`;

  return {
    sourceExternalId: sourceLookup.sourceExternalId,
    sourceUrl: sourceLookup.sourceUrl,
    title,
    text,
    sourceMetadata: {
      provider: "notion",
      id: sourceLookup.sourceExternalId,
      url: page.url ?? sourceLookup.sourceUrl,
      title,
    },
  };
}

export function parseSourceUrl(sourceUrl: string): SourceLookupResult {
  const id = extractNotionPageId(sourceUrl);
  if (!id) {
    throw createInvalidSourceUrlError(
      "notion",
      "That is not a Notion page URL. Use Share -> Copy link on the page you want to import.",
    );
  }
  return {
    sourceExternalId: id,
    sourceUrl: buildSourceUrl(id),
  };
}

export async function revokeAccessToken(token: string): Promise<void> {
  await requestNotionTokenRevocation(token);
}

export function isNotionApiError(value: unknown): value is NotionApiError {
  return isProviderApiError(value) && value.provider === "notion";
}
