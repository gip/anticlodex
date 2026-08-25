import { createHash } from "node:crypto";
import type { DocSourceType } from "./integrations/index.js";

// Document bodies are stored with a small YAML-ish front matter carrying the
// document's name and description; everything after it is the markdown body.
// The hash over kind/title/language/body is the document's identity, which is
// why editing a document inserts a new row and repoints the matrix refs at it
// rather than updating in place.

export type DocKind = "Document" | "Skill" | "Prompt";

export interface ParsedDocumentText {
  name: string;
  description: string;
  body: string;
}

export interface MatrixDocumentAttach {
  nodeId: string;
  concern: string;
  concerns: string[];
  refType: DocKind;
  docHash?: string;
}

export interface MatrixRefPayload {
  nodeId: string;
  concern: string;
  concerns: string[];
  docHash: string;
  refType: DocKind;
}

export interface MatrixDocumentCreatePayload {
  kind: DocKind;
  language: string;
  sourceType: DocSourceType;
  title?: string;
  name?: string;
  description?: string;
  body?: string;
  sourceUrl?: string;
  attach?: MatrixDocumentAttach;
}

export interface MatrixDocumentReplacePayload {
  title?: string;
  name?: string;
  description?: string;
  language?: string;
  body?: string;
}

export function isDocumentKind(value: string): value is DocKind {
  return value === "Document" || value === "Skill" || value === "Prompt";
}

export function computeDocumentHash(document: {
  kind: DocKind;
  title: string;
  language: string;
  body: string;
}): string {
  const payload = [document.kind, document.title, document.language, document.body].join("\n");
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

export function deriveDocumentName(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isValidDocumentName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

export function parseDocumentText(rawText: string): ParsedDocumentText {
  const text = (rawText ?? "").replace(/\r\n/g, "\n");
  const match = text.startsWith("---\n")
    ? text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    : null;
  if (!match) {
    return { name: "", description: "", body: text.trim() };
  }

  const parsed: ParsedDocumentText = { name: "", description: "", body: match[2].trim() };
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "name") parsed.name = value;
    else if (key === "description") parsed.description = value;
  }

  return parsed;
}

export function buildDocumentText(
  { name, description, body }: { name: string; description: string; body: string },
): string {
  // The description has to stay on one line: the front matter is parsed line by
  // line, so an embedded newline would silently truncate it on the next read.
  const normalizedDescription = description.trim().replace(/\r?\n/g, " ");
  return ["---", `name: ${name}`, `description: ${normalizedDescription}`, "---", body.trim()].join("\n");
}

export function parseConcernList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const concerns: string[] = [];
  const seen = new Set<string>();

  for (const concern of raw) {
    if (typeof concern !== "string") return null;
    const nextConcern = concern.trim();
    if (!nextConcern || seen.has(nextConcern)) continue;
    seen.add(nextConcern);
    concerns.push(nextConcern);
  }

  return concerns.length > 0 ? concerns : null;
}

// Callers may send either a single `concern` or a `concerns` list; the list wins
// when both are present, and the first entry is echoed back as `concern` so the
// single-cell response shape stays available.
function resolveConcerns(raw: { concern?: unknown; concerns?: unknown }): string[] | null {
  const fromList = parseConcernList(raw.concerns);
  if (fromList?.length) return fromList;
  const single = typeof raw.concern === "string" ? raw.concern.trim() : "";
  return single ? [single] : null;
}

export function normalizeMatrixRefBody(body: unknown): MatrixRefPayload | null {
  if (!body || typeof body !== "object") return null;
  const parsed = body as Record<string, unknown>;

  if (
    typeof parsed.nodeId !== "string"
    || typeof parsed.docHash !== "string"
    || typeof parsed.refType !== "string"
  ) {
    return null;
  }

  const nodeId = parsed.nodeId.trim();
  const docHash = parsed.docHash.trim();
  const concerns = resolveConcerns(parsed);

  if (!nodeId || !docHash || !concerns) return null;
  if (!isDocumentKind(parsed.refType)) return null;

  return { nodeId, concern: concerns[0], concerns, docHash, refType: parsed.refType };
}

export function parseDocumentAttach(attach: unknown): MatrixDocumentAttach | undefined {
  if (!attach || typeof attach !== "object") return undefined;
  const parsed = attach as Record<string, unknown>;
  if (typeof parsed.nodeId !== "string" || typeof parsed.refType !== "string") return undefined;

  const nodeId = parsed.nodeId.trim();
  const concerns = resolveConcerns(parsed);
  if (!nodeId || !concerns) return undefined;
  if (!isDocumentKind(parsed.refType)) return undefined;

  const docHash = typeof parsed.docHash === "string" ? parsed.docHash.trim() : "";
  return {
    nodeId,
    concern: concerns[0],
    concerns,
    refType: parsed.refType,
    docHash: docHash || undefined,
  };
}

export function normalizeMatrixDocumentCreateBody(body: unknown): MatrixDocumentCreatePayload | null {
  if (!body || typeof body !== "object") return null;
  const parsed = body as Record<string, unknown>;

  if (typeof parsed.kind !== "string" || !isDocumentKind(parsed.kind)) return null;

  const sourceType: DocSourceType = parsed.sourceType === "notion" || parsed.sourceType === "google_doc"
    ? parsed.sourceType
    : "local";
  const language = typeof parsed.language === "string" && parsed.language.trim()
    ? parsed.language.trim()
    : "en";
  const attach = parseDocumentAttach(parsed.attach);

  if (sourceType === "local") {
    if (
      typeof parsed.title !== "string"
      || typeof parsed.name !== "string"
      || typeof parsed.description !== "string"
    ) {
      return null;
    }
    const title = parsed.title.trim();
    const name = parsed.name.trim();
    if (!title || !name || !isValidDocumentName(name)) return null;

    return {
      kind: parsed.kind,
      sourceType,
      language,
      title,
      name,
      description: parsed.description.trim(),
      body: typeof parsed.body === "string" ? parsed.body : "",
      attach,
    };
  }

  // A remote document's title and text come from the provider, so the only
  // required field is the URL to import from.
  if (typeof parsed.sourceUrl !== "string" || !parsed.sourceUrl.trim()) return null;
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";

  return {
    kind: parsed.kind,
    sourceType,
    language,
    title: title || undefined,
    sourceUrl: parsed.sourceUrl.trim(),
    attach,
  };
}

export function normalizeMatrixDocumentReplaceBody(body: unknown): MatrixDocumentReplacePayload | null {
  if (!body || typeof body !== "object") return null;
  const parsed = body as Record<string, unknown>;

  const normalized: MatrixDocumentReplacePayload = {};
  let hasAny = false;

  if (typeof parsed.title !== "undefined") {
    if (typeof parsed.title !== "string" || !parsed.title.trim()) return null;
    normalized.title = parsed.title.trim();
    hasAny = true;
  }
  if (typeof parsed.name !== "undefined") {
    if (typeof parsed.name !== "string" || !isValidDocumentName(parsed.name.trim())) return null;
    normalized.name = parsed.name.trim();
    hasAny = true;
  }
  if (typeof parsed.description !== "undefined") {
    if (typeof parsed.description !== "string") return null;
    normalized.description = parsed.description.trim();
    hasAny = true;
  }
  if (typeof parsed.language !== "undefined") {
    if (typeof parsed.language !== "string" || !parsed.language.trim()) return null;
    normalized.language = parsed.language.trim();
    hasAny = true;
  }
  if (typeof parsed.body !== "undefined") {
    if (typeof parsed.body !== "string") return null;
    normalized.body = parsed.body;
    hasAny = true;
  }

  return hasAny ? normalized : null;
}

function buildNodeScopedSummary(
  nodeName: string | null,
  title: string,
  verb: "added" | "removed" | "updated",
): string {
  if (nodeName) return `In the ${nodeName}, the document "${title}" was ${verb}.`;
  return `The document "${title}" was ${verb}.`;
}

export function buildDocumentAddSummary(title: string, nodeName: string | null): string {
  return buildNodeScopedSummary(nodeName, title, "added");
}

export function buildDocumentRemoveSummary(title: string, nodeName: string | null): string {
  return buildNodeScopedSummary(nodeName, title, "removed");
}

export function buildDocumentCreateSummary(
  title: string,
  sourceType: DocSourceType,
  nodeName: string | null,
  hasAttachment: boolean,
): string {
  if (hasAttachment) return buildNodeScopedSummary(nodeName, title, "added");
  if (sourceType === "local") return `The document "${title}" was created.`;
  return `The document "${title}" was imported.`;
}

export function buildDocumentModifySummary(
  previousTitle: string,
  nextTitle: string,
  nodeNames: string[],
): string {
  const title = nextTitle || previousTitle;
  if (nodeNames.length === 1) return `In the ${nodeNames[0]}, the document "${title}" was updated.`;
  if (nodeNames.length > 1) return `In ${nodeNames.length} nodes, the document "${title}" was updated.`;
  return `The document "${title}" was updated.`;
}
