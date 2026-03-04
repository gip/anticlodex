import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { PoolClient } from "pg";
import pool, { query } from "./db.js";

const SYSTEM_PROMPT_CONCERN = "__system_prompt__";
const OPENSHIP_ROOT_NODE_ID = "s.root";
const TYPED_NODE_ID_SCHEME = "typed_key_v1";
const TYPED_NODE_ID_PATTERN = /^([hcpl])\.([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const NODE_OWNERSHIP_VALUES = new Set(["first_party", "third_party"]);
const NODE_BOUNDARY_VALUES = new Set(["internal", "external"]);

type YamlScalar = string | number | boolean | null;
interface YamlObject {
  [key: string]: YamlValue;
}
type YamlValue = YamlScalar | YamlValue[] | YamlObject;

export interface OpenShipBundleFile {
  path: string;
  content: string;
}

interface ApplyOpenShipSyncInput {
  threadId: string;
  bundleFiles: OpenShipBundleFile[];
}

interface ParsedOpenShipManifest {
  systemNodeId: string;
  systemName: string;
  specVersion: string;
  concerns: string[];
  systemPromptRefs: string[];
}

interface ParsedOpenShipEdge {
  id: string;
  type: "Runtime" | "Dataflow" | "Dependency";
  fromNodeId: string;
  toNodeId: string;
  metadata: Record<string, YamlValue>;
}

interface ParsedNodeArtifactCode {
  id: string;
  concern: string;
  files: string[];
}

interface ParsedNodeManifest {
  id: string;
  kind: "Root" | "Host" | "Container" | "Process" | "Library";
  name: string;
  parentId?: string;
  metadata: Record<string, YamlValue>;
  matrix: Record<string, { documentRefs: string[]; skillRefs: string[] }>;
  summaryArtifactIds: string[];
  docsArtifactIds: string[];
  codeArtifacts: ParsedNodeArtifactCode[];
  systemPromptRefs: string[];
}

interface ParsedDocumentArtifact {
  id: string;
  nodeId: string;
  concern: string;
  type: "Summary" | "Docs";
  language: string;
  text: string;
}

interface ParsedDocumentFile {
  kind: "Document" | "Skill";
  hash: string;
  title: string;
  language: string;
  text: string;
  supersedes?: string | null;
}

interface ParsedOpenShipBundle {
  manifest: ParsedOpenShipManifest;
  edges: ParsedOpenShipEdge[];
  nodes: ParsedNodeManifest[];
  documents: ParsedDocumentFile[];
  summaryArtifacts: ParsedDocumentArtifact[];
  docsArtifacts: ParsedDocumentArtifact[];
  codeArtifactFiles: Map<string, string>;
}

export async function collectOpenShipBundleFiles(bundleDir: string): Promise<OpenShipBundleFile[]> {
  const entries = await readdir(bundleDir, { withFileTypes: true });
  const files: OpenShipBundleFile[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = join(bundleDir, entry.name);

    if (entry.isDirectory()) {
      const nested = await collectOpenShipBundleFiles(childPath);
      for (const nestedFile of nested) {
        const relativePath = normalizePath(`${entry.name}/${nestedFile.path}`);
        files.push({ path: relativePath, content: nestedFile.content });
      }
      continue;
    }

    if (!entry.isFile()) continue;

    const content = await readFile(childPath, "utf8");
    files.push({ path: normalizePath(entry.name), content });
  }

  return files;
}

function normalizePath(value: string): string {
  return value.replace(/\\+/g, "/");
}

function splitFrontMatter(
  raw: string,
  filePath: string,
): { attributes: Record<string, YamlValue>; content: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error(`Invalid front matter payload; file=${filePath}; rawPreview="${previewYaml(raw)}"`);
  }

  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      endIndex = index;
      break;
    }
  }

  if (endIndex === -1) {
    throw new Error(`Invalid front matter payload; file=${filePath}; rawPreview="${previewYaml(raw)}"`);
  }

  const rawAttributes = lines.slice(1, endIndex).join("\n");
  const attributes = parseYamlDocument(rawAttributes, {
    filePath,
    section: "front matter",
  }) as Record<string, YamlValue>;
  const content = lines.slice(endIndex + 1).join("\n");
  return { attributes, content };
}

interface YamlParseContext {
  filePath?: string;
  section?: string;
}

function formatYamlParseError(
  message: string,
  input: string,
  context?: YamlParseContext,
  lineNumber?: number,
  line?: string,
): string {
  const file = context?.filePath ?? "unknown file";
  const section = context?.section ? `; section=${context.section}` : "";
  const lineInfo = lineNumber ? `; line=${lineNumber}` : "";
  const lineText = line ? `; lineText="${line.replace(/"/g, "\\\"")}"` : "";
  return `${message}; file=${file}${section}${lineInfo}${lineText}; rawPreview="${previewYaml(input)}"`;
}

function parseYamlDocument(input: string, context?: YamlParseContext): YamlValue {
  try {
    const parsed = parseYaml(input);
    return parsed === null || typeof parsed === "undefined" ? {} : parsed as YamlValue;
  } catch (error: unknown) {
    const line = typeof error === "object" && error !== null && "line" in error
      ? Number((error as { line?: number }).line)
      : undefined;
    const lineText = typeof line === "number" && line >= 1
      ? (input.split(/\r?\n/)[line - 1] ?? "")
      : undefined;
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(formatYamlParseError(details, input, context, Number.isFinite(line ?? Number.NaN) ? line : undefined, lineText));
  }
}

function asString(value: YamlValue, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${label}; expected non-empty string.`);
  }
  return value;
}

function asStringList(value: YamlValue | undefined, label: string): string[] {
  if (!value) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}; expected array.`);
  }
  return value
    .map((entry) => {
      if (typeof entry !== "string") {
        return null;
      }
      return entry;
    })
    .filter((value): value is string => Boolean(value));
}

function asRecord(value: YamlValue | undefined, label: string): Record<string, YamlValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}; expected object.`);
  }
  return value;
}

function describeYamlValue(value: YamlValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === "object") return `object(keys=${Object.keys(value).join(", ") || "<empty>"})`;
  if (typeof value === "string") return `string(len=${value.length}, preview="${value.slice(0, 120)}")`;
  return `${typeof value}(${String(value)})`;
}

function previewYaml(raw: string, maxChars = 600): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const compact = normalized.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}...` : compact;
}

function parseOpenShipManifest(raw: string): ParsedOpenShipManifest {
  const parsed = parseYamlDocument(raw, {
    filePath: "openship.yaml",
    section: "manifest",
  });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid OpenShip manifest payload.");
  }

  const manifest = parsed as Record<string, YamlValue>;

  return {
    specVersion: asString(manifest.specVersion, "manifest specVersion"),
    systemNodeId: asString(manifest.systemNodeId, "manifest systemNodeId"),
    systemName: asString(manifest.systemName, "manifest systemName"),
    concerns: asStringList(manifest.concerns, "manifest concerns"),
    systemPromptRefs: asStringList(manifest.systemPromptRefs, "manifest systemPromptRefs"),
  };
}

function parseOpenShipEdges(raw: string): ParsedOpenShipEdge[] {
  const filePath = "edges/edges.yaml";
  const edgesError = (details: string): never => {
    throw new Error(`Invalid edges file; expected object. ${details}`);
  };

  const parsed = parseYamlDocument(raw, {
    filePath: "edges/edges.yaml",
    section: "edges",
  });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    edgesError(
      `file="${filePath}"; topLevel=${describeYamlValue(parsed)}; rawPreview="${previewYaml(raw)}"`,
    );
  }

  const edgeFile = parsed as Record<string, YamlValue>;
  const topLevelKeys = Object.keys(edgeFile);
  const edgesPayload = edgeFile.edges;
  let edgesList: YamlValue[] = [];

  if (Array.isArray(edgesPayload)) {
    edgesList = edgesPayload;
  } else if (edgesPayload && typeof edgesPayload === "object" && !Array.isArray(edgesPayload)) {
    const nested = edgesPayload as Record<string, YamlValue>;
    const nestedEdges = nested.edges;
    if (!Array.isArray(nestedEdges)) {
      edgesError(
        `topLevelKeys=${topLevelKeys.join(", ") || "<empty>"}, nested edges=${describeYamlValue(
          nestedEdges,
        )}; rawPreview="${previewYaml(raw)}"`,
      );
    }
    edgesList = nestedEdges as YamlValue[];
  } else {
    edgesError(
      `topLevelKeys=${topLevelKeys.join(", ") || "<empty>"}, edges value=${describeYamlValue(
        edgesPayload,
      )}; rawPreview="${previewYaml(raw)}"`,
    );
  }

  if (!Array.isArray(edgesList)) {
    edgesError(
      `topLevelKeys=${topLevelKeys.join(", ") || "<empty>"}, edges value=${describeYamlValue(
        edgesPayload,
      )}; rawPreview="${previewYaml(raw)}"`,
    );
  }

  return edgesList.map((entry, index) => {
    const normalizedEntry = entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      edgesError(
        `Invalid edge entry at index ${index} in ${filePath}; value=${describeYamlValue(normalizedEntry)}; ` +
          `rawPreview="${previewYaml(raw)}"`,
      );
    }

    const edge = entry as Record<string, YamlValue>;
    let from = "";
    let to = "";
    let type: ParsedOpenShipEdge["type"] = "Dependency";
    let metadata: Record<string, YamlValue> = {};
    try {
      from = asString(edge.fromNodeId, `edge ${index} in ${filePath} fromNodeId`);
      to = asString(edge.toNodeId, `edge ${index} in ${filePath} toNodeId`);
      type = asString(edge.type, `edge ${index} in ${filePath} type`) as ParsedOpenShipEdge["type"];
      if (edge.metadata !== undefined) {
        metadata = asRecord(edge.metadata, `edge ${index} in ${filePath} metadata`) as Record<string, YamlValue>;
      }
    } catch (error: unknown) {
      edgesError(
        `edge ${index} in ${filePath} has invalid fields; source=${describeYamlValue(entry as YamlValue)}; ` +
          `error="${error instanceof Error ? error.message : String(error)}"; rawPreview="${previewYaml(raw)}"`,
      );
    }

    if (!from || !to || !type) {
      edgesError(`edge ${index} in ${filePath} was missing required fields after parsing: ${JSON.stringify(edge)}`);
    }

    return {
      id: asString(edge.id, `edge ${index} id`),
      type,
      fromNodeId: from,
      toNodeId: to,
      metadata,
    };
  });
}

function parseOpenShipNodeManifest(raw: string, filePath: string): ParsedNodeManifest {
  const parsed = parseYamlDocument(raw, {
    filePath,
    section: "node",
  });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid node payload.");
  }

  const node = parsed as Record<string, YamlValue>;

  const matrixNode = asRecord(node.matrix, `node ${asString(node.id, "node id")}.matrix`);
  const matrix: Record<string, { documentRefs: string[]; skillRefs: string[] }> = {};

  for (const [concern, rawConcernValue] of Object.entries(matrixNode)) {
    const concernCell = asRecord(rawConcernValue, `node ${asString(node.id, "node id")} matrix concern ${concern}`);
    matrix[concern] = {
      documentRefs: asStringList(concernCell.documentRefs, `node ${asString(node.id, "node id")} concern ${concern} documentRefs`),
      skillRefs: asStringList(concernCell.skillRefs, `node ${asString(node.id, "node id")} concern ${concern} skillRefs`),
    };
  }

  const artifactsNode = asRecord(node.artifacts, `node ${asString(node.id, "node id")}.artifacts`);
  const rawSummary = asStringList(artifactsNode.Summary, `node ${asString(node.id, "node id")} artifacts.Summary`);
  const rawDocs = asStringList(artifactsNode.Docs, `node ${asString(node.id, "node id")} artifacts.Docs`);
  const rawCode = Array.isArray(artifactsNode.Code)
    ? artifactsNode.Code
    : [];

  const codeArtifacts = rawCode.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid code artifact entry at node ${asString(node.id, "node id")} index ${index}.`);
    }
    const artifact = entry as Record<string, YamlValue>;
    return {
      id: asString(artifact.id, `node ${asString(node.id, "node id")} code artifact id`),
      concern: asString(artifact.concern, `node ${asString(node.id, "node id")} code artifact concern`),
      files: asStringList(artifact.files, `node ${asString(node.id, "node id")} code artifact files`),
    };
  });

  return {
    id: asString(node.id, "node id"),
    kind: asString(node.kind, `node ${asString(node.id, "node id")} kind`) as ParsedNodeManifest["kind"],
    name: asString(node.name, `node ${asString(node.id, "node id")} name`),
    parentId: typeof node.parentId === "string" ? node.parentId : undefined,
    metadata: (asRecord(node.metadata, `node ${asString(node.id, "node id")} metadata`) as Record<string, YamlValue>) ?? {},
    matrix,
    summaryArtifactIds: rawSummary,
    docsArtifactIds: rawDocs,
    codeArtifacts,
    systemPromptRefs: asStringList(node.systemPromptRefs, `node ${asString(node.id, "node id")} systemPromptRefs`),
  };
}

function parseDocumentArtifact(raw: string, filePath: string): ParsedDocumentArtifact {
  const { attributes } = splitFrontMatter(raw, filePath);

  if (typeof attributes.id !== "string") {
    throw new Error("Invalid artifact front matter: missing id.");
  }

  if (typeof attributes.nodeId !== "string") {
    throw new Error(`Invalid artifact front matter for ${attributes.id}: missing nodeId.`);
  }

  if (typeof attributes.concern !== "string") {
    throw new Error(`Invalid artifact front matter for ${attributes.id}: missing concern.`);
  }

  const type = asString(attributes.type, `artifact ${attributes.id} type`);
  if (type !== "Summary" && type !== "Docs") {
    throw new Error(`Unexpected artifact type for ${attributes.id}: ${type}.`);
  }

  return {
    id: attributes.id,
    nodeId: attributes.nodeId,
    concern: attributes.concern,
    type: type as "Summary" | "Docs",
    language: asString(attributes.language ?? "en", `artifact ${attributes.id} language`),
    text: asString(
      raw.split("\n---").slice(1).join("\n---").replace(/^\r?\n/, ""),
      `artifact ${attributes.id} content`,
    )
      ? raw.split("\n---").slice(1).join("\n---").replace(/^\r?\n/, "")
      : "",
  };
}

function parseDocumentFile(raw: string, filePath: string): ParsedDocumentFile {
  const { attributes } = splitFrontMatter(raw, filePath);

  const kind = asString(attributes.kind ?? "", "document kind");
  if (kind !== "Document" && kind !== "Skill") {
    throw new Error(`Unexpected document kind: ${kind}.`);
  }

  return {
    kind: kind as "Document" | "Skill",
    hash: asString(attributes.hash ?? "", "document hash"),
    title: asString(attributes.title, "document title"),
    language: asString(attributes.language ?? "en", "document language"),
    text: raw.split("\n---").slice(1).join("\n---").replace(/^\r?\n/, ""),
    supersedes: typeof attributes.supersedes === "string" ? attributes.supersedes : null,
  };
}

function extractBundleContent(files: OpenShipBundleFile[]): ParsedOpenShipBundle {
  const fileByPath = new Map<string, string>(files.map((entry) => [normalizePath(entry.path), entry.content]));
  const manifestContent = fileByPath.get("openship.yaml");
  if (!manifestContent) {
    throw new Error("Missing openship.yaml in bundle payload.");
  }

  const edgesContent = fileByPath.get("edges/edges.yaml");

  const manifest = parseOpenShipManifest(manifestContent);
  const edges = edgesContent ? parseOpenShipEdges(edgesContent) : [];
  const nodes: ParsedNodeManifest[] = [];
  const documents: ParsedDocumentFile[] = [];
  const summaryArtifacts: ParsedDocumentArtifact[] = [];
  const docsArtifacts: ParsedDocumentArtifact[] = [];
  const codeArtifactFiles = new Map<string, string>();

  for (const [path, content] of fileByPath.entries()) {
    if (path === "openship.yaml" || path === "edges/edges.yaml") continue;

    const documentMatch = /^inputs\/(documents|skills)\/(.+)\.md$/.exec(path);
    if (documentMatch) {
      documents.push(parseDocumentFile(content, path));
      continue;
    }

    const nodeMatch = /^nodes\/(.+)\/node\.yaml$/.exec(path);
    if (nodeMatch) {
      nodes.push(parseOpenShipNodeManifest(content, path));
      continue;
    }

    const summaryMatch = /^nodes\/(.+)\/artifacts\/(summary|docs)\/(.+)\.md$/.exec(path);
    if (summaryMatch) {
      const artifact = parseDocumentArtifact(content, path);
      if (summaryMatch[2] === "summary") {
        summaryArtifacts.push(artifact);
      } else {
        docsArtifacts.push(artifact);
      }
      continue;
    }

    const codeMatch = /^nodes\/.+\/artifacts\/code\/.+/.exec(path);
    if (codeMatch) {
      codeArtifactFiles.set(path, content);
    }
  }

  return {
    manifest,
    edges,
    nodes,
    documents,
    summaryArtifacts,
    docsArtifacts,
    codeArtifactFiles,
  };
}

async function upsertDocumentArtifacts(
  client: PoolClient,
  systemId: string,
  artifact: ParsedDocumentArtifact,
): Promise<string> {
  await client.query(
    `INSERT INTO artifacts (id, system_id, node_id, concern, type, language, text)
     VALUES ($1, $2, $3, $4, $5::artifact_type, $6, $7)
     ON CONFLICT (system_id, id) DO UPDATE
       SET
         node_id = EXCLUDED.node_id,
         concern = EXCLUDED.concern,
         type = EXCLUDED.type,
         language = EXCLUDED.language,
         text = EXCLUDED.text,
         updated_at = now()`,
    [artifact.id, systemId, artifact.nodeId, artifact.concern, artifact.type, artifact.language, artifact.text],
  );
  return artifact.id;
}

function appendSystemPromptRefs(
  nodePayloads: ParsedNodeManifest[],
  manifest: ParsedOpenShipManifest,
  resolvedRootNodeId: string,
): string[] {
  const root = resolvedRootNodeId;
  const rootNode = nodePayloads.find((node) => node.id === root);
  const refs = new Set<string>([...manifest.systemPromptRefs]);
  if (rootNode) {
    for (const hash of rootNode.systemPromptRefs) {
      refs.add(hash);
    }
  }
  return Array.from(refs);
}

function validateMatrixRefTargets(parsed: ParsedOpenShipBundle): void {
  const documentHashes = new Set(
    parsed.documents
      .filter((document) => document.kind === "Document")
      .map((document) => document.hash),
  );
  const skillHashes = new Set(
    parsed.documents
      .filter((document) => document.kind === "Skill")
      .map((document) => document.hash),
  );

  const missingRefs: string[] = [];
  for (const node of parsed.nodes) {
    for (const [concern, refs] of Object.entries(node.matrix)) {
      if (!concern || concern === SYSTEM_PROMPT_CONCERN) continue;

      for (const hash of refs.documentRefs) {
        if (!documentHashes.has(hash)) {
          missingRefs.push(`node=${node.id} concern=${concern} ref_type=Document hash=${hash}`);
        }
      }

      for (const hash of refs.skillRefs) {
        if (!skillHashes.has(hash)) {
          missingRefs.push(`node=${node.id} concern=${concern} ref_type=Skill hash=${hash}`);
        }
      }
    }
  }

  if (missingRefs.length === 0) {
    return;
  }

  const preview = missingRefs.slice(0, 10).join("; ");
  const suffix = missingRefs.length > 10 ? `; +${missingRefs.length - 10} more` : "";
  throw new Error(`OpenShip matrix references missing documents: ${preview}${suffix}`);
}

function validateLibraryContainmentAndDependencyEdges(parsed: ParsedOpenShipBundle): void {
  const nodeKindById = new Map<string, ParsedNodeManifest["kind"]>(
    parsed.nodes.map((node) => [node.id, node.kind]),
  );

  for (const node of parsed.nodes) {
    if (node.kind === "Library" && node.parentId !== undefined) {
      throw new Error(`Invalid Library placement for node "${node.id}"; libraries must be top-level and cannot define parentId.`);
    }
  }

  for (const edge of parsed.edges) {
    if (edge.type !== "Dependency") {
      continue;
    }

    const fromKind = nodeKindById.get(edge.fromNodeId);
    if (fromKind !== "Process") {
      throw new Error(
        `Invalid Dependency edge "${edge.id}": fromNodeId "${edge.fromNodeId}" must exist and be a Process.`,
      );
    }

    const toKind = nodeKindById.get(edge.toNodeId);
    if (toKind !== "Library") {
      throw new Error(
        `Invalid Dependency edge "${edge.id}": toNodeId "${edge.toNodeId}" must exist and be a Library.`,
      );
    }
  }
}

function validateNodeOwnershipAndBoundary(parsed: ParsedOpenShipBundle): void {
  for (const node of parsed.nodes) {
    const ownership = typeof node.metadata.ownership === "string" ? node.metadata.ownership : null;
    const boundary = typeof node.metadata.boundary === "string" ? node.metadata.boundary : null;
    const name = typeof node.name === "string" ? node.name.trim() : "";

    if (!ownership || !NODE_OWNERSHIP_VALUES.has(ownership)) {
      throw new Error(
        `Invalid node "${node.id}" metadata.ownership; expected one of first_party|third_party.`,
      );
    }

    if (!boundary || !NODE_BOUNDARY_VALUES.has(boundary)) {
      throw new Error(
        `Invalid node "${node.id}" metadata.boundary; expected one of internal|external.`,
      );
    }
    if (name.length === 0) {
      throw new Error(`Invalid node "${node.id}" name; expected non-empty string.`);
    }
  }
}

function resolveOpenShipRootNodeId(manifestRootNodeId: string, nodeLookup: Map<string, ParsedNodeManifest>): string {
  if (manifestRootNodeId === OPENSHIP_ROOT_NODE_ID) {
    if (!nodeLookup.has(OPENSHIP_ROOT_NODE_ID)) {
      throw new Error(`Missing root node ${OPENSHIP_ROOT_NODE_ID} in nodes manifest.`);
    }
    return OPENSHIP_ROOT_NODE_ID;
  }

  if (!nodeLookup.has(manifestRootNodeId)) {
    throw new Error(`Missing root node ${manifestRootNodeId} in nodes manifest.`);
  }

  return manifestRootNodeId;
}

function resolveNodeIdScheme(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).nodeIdScheme;
  return typeof value === "string" ? value : null;
}

function validateTypedNodeScheme(
  parsed: ParsedOpenShipBundle,
  resolvedSystemNodeId: string,
  baseNodeKinds: Map<string, ParsedNodeManifest["kind"]>,
): void {
  const kindPrefix = (kind: ParsedNodeManifest["kind"]): string => {
    if (kind === "Host") return "h";
    if (kind === "Container") return "c";
    if (kind === "Process") return "p";
    if (kind === "Library") return "l";
    return "s";
  };

  if (resolvedSystemNodeId !== OPENSHIP_ROOT_NODE_ID) {
    throw new Error(`Typed node ID scheme requires root node id ${OPENSHIP_ROOT_NODE_ID}.`);
  }

  for (const node of parsed.nodes) {
    if (node.id === OPENSHIP_ROOT_NODE_ID) {
      if (node.kind !== "Root") {
        throw new Error(`Root node ${OPENSHIP_ROOT_NODE_ID} must have kind Root.`);
      }
      continue;
    }

    const idMatch = TYPED_NODE_ID_PATTERN.exec(node.id);
    if (!idMatch) {
      throw new Error(`Invalid node id "${node.id}" for typed node ID scheme.`);
    }

    const expectedPrefix = kindPrefix(node.kind);
    if (idMatch[1] !== expectedPrefix) {
      throw new Error(
        `Node "${node.id}" kind "${node.kind}" does not match expected prefix "${expectedPrefix}".`,
      );
    }

    const expectedKey = idMatch[2];
    const openShipKey = typeof node.metadata.openshipKey === "string" ? node.metadata.openshipKey : null;
    if (!openShipKey) {
      throw new Error(`Missing metadata.openshipKey for node "${node.id}" in typed node ID scheme.`);
    }
    if (openShipKey !== expectedKey) {
      throw new Error(
        `Node "${node.id}" has metadata.openshipKey="${openShipKey}" but expected "${expectedKey}".`,
      );
    }

    const baseKind = baseNodeKinds.get(node.id);
    if (baseKind && baseKind !== node.kind) {
      throw new Error(`Node "${node.id}" kind change is not allowed (${baseKind} -> ${node.kind}).`);
    }
  }
}

async function ensurePromptDocsExist(
  client: PoolClient,
  systemId: string,
  rootNodeId: string,
  promptRefs: string[],
): Promise<void> {
  if (!promptRefs.length) {
    await client.query(
      `DELETE FROM matrix_refs
       WHERE system_id = $1 AND node_id = $2 AND concern = $3 AND ref_type = 'Prompt'::ref_type`,
      [systemId, rootNodeId, SYSTEM_PROMPT_CONCERN],
    );
    return;
  }

  const existingResult = await client.query<{ hash: string }>(
    `SELECT hash FROM documents
      WHERE system_id = $1
        AND kind = 'Prompt'::doc_kind`,
    [systemId],
  );
  const existing = new Set(existingResult.rows.map((row) => row.hash));

  for (const hash of promptRefs) {
    if (!existing.has(hash)) {
      throw new Error(`Unable to resolve system prompt document ${hash}.`);
    }
  }

  await client.query(
    `DELETE FROM matrix_refs
     WHERE system_id = $1 AND node_id = $2 AND concern = $3 AND ref_type = 'Prompt'::ref_type`,
    [systemId, rootNodeId, SYSTEM_PROMPT_CONCERN],
  );

  for (const hash of promptRefs) {
    await client.query(
      `INSERT INTO matrix_refs (system_id, node_id, concern, ref_type, doc_hash)
       VALUES ($1, $2, $3, 'Prompt'::ref_type, $4)
       ON CONFLICT DO NOTHING`,
      [systemId, rootNodeId, SYSTEM_PROMPT_CONCERN, hash],
    );
  }
}

async function upsertMatrixRefs(
  client: PoolClient,
  systemId: string,
  node: ParsedNodeManifest,
  concernByNode: string,
): Promise<void> {
  for (const documentHash of node.matrix[concernByNode]?.documentRefs ?? []) {
    await client.query(
      `INSERT INTO matrix_refs (system_id, node_id, concern, ref_type, doc_hash)
       VALUES ($1, $2, $3, 'Document'::ref_type, $4)
       ON CONFLICT DO NOTHING`,
      [systemId, node.id, concernByNode, documentHash],
    );
  }

  for (const skillHash of node.matrix[concernByNode]?.skillRefs ?? []) {
    await client.query(
      `INSERT INTO matrix_refs (system_id, node_id, concern, ref_type, doc_hash)
       VALUES ($1, $2, $3, 'Skill'::ref_type, $4)
       ON CONFLICT DO NOTHING`,
      [systemId, node.id, concernByNode, skillHash],
    );
  }
}

export async function applyOpenShipBundleToThreadSystemWithClient(
  client: PoolClient,
  { threadId, bundleFiles }: ApplyOpenShipSyncInput,
): Promise<string> {
  const parsed = extractBundleContent(bundleFiles);
  validateMatrixRefTargets(parsed);
  const baseSystemResult = await client.query<{ system_id: string }>(
    `SELECT thread_current_system($1) AS system_id`,
    [threadId],
  );
  const baseSystemId = baseSystemResult.rows[0]?.system_id;
  if (!baseSystemId) {
    throw new Error("Unable to resolve thread system.");
  }

  const baseSystemMetadataResult = await client.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata FROM systems WHERE id = $1`,
    [baseSystemId],
  );
  const baseSystemMetadata = baseSystemMetadataResult.rows[0]?.metadata ?? null;
  const nodeIdScheme = resolveNodeIdScheme(baseSystemMetadata);
  const typedNodeSchemeEnabled = nodeIdScheme === TYPED_NODE_ID_SCHEME;

  const baseNodeKinds = new Map<string, ParsedNodeManifest["kind"]>();
  if (typedNodeSchemeEnabled) {
    const baseNodesResult = await client.query<{ id: string; kind: ParsedNodeManifest["kind"] }>(
      `SELECT id, kind::text AS kind
       FROM nodes
       WHERE system_id = $1`,
      [baseSystemId],
    );
    for (const row of baseNodesResult.rows) {
      baseNodeKinds.set(row.id, row.kind);
    }
  }

  const updateActionId = randomUUID();
  const action = await client.query<{ output_system_id: string }>(
    `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
    [threadId, updateActionId, "Update", "Apply OpenShip bundle changes"],
  );
  const systemId = action.rows[0]?.output_system_id;
  if (!systemId) {
    throw new Error("Unable to start OpenShip reconciliation action.");
  }

  const manifest = parsed.manifest;
  const sortedConcerns = Array.from(new Set((manifest.concerns ?? []).filter((value) => value && value !== SYSTEM_PROMPT_CONCERN)));

  const concernsFromMatrix = new Set<string>();
  for (const node of parsed.nodes) {
    for (const concern of Object.keys(node.matrix)) {
      if (concern && concern !== SYSTEM_PROMPT_CONCERN) {
        concernsFromMatrix.add(concern);
      }
    }
  }

  const concernNames = [
    ...sortedConcerns,
    ...Array.from(concernsFromMatrix).filter((concern) => !sortedConcerns.includes(concern)),
  ];

  const nodeLookup = new Map<string, ParsedNodeManifest>(parsed.nodes.map((node) => [node.id, node]));
  const resolvedSystemNodeId = resolveOpenShipRootNodeId(manifest.systemNodeId, nodeLookup);
  validateLibraryContainmentAndDependencyEdges(parsed);
  validateNodeOwnershipAndBoundary(parsed);
  if (typedNodeSchemeEnabled) {
    validateTypedNodeScheme(parsed, resolvedSystemNodeId, baseNodeKinds);
  }

  await client.query(
    `UPDATE systems
       SET name = $1,
           spec_version = $2,
           root_node_id = $3,
           updated_at = now()
     WHERE id = $4`,
    [manifest.systemName, manifest.specVersion, resolvedSystemNodeId, systemId],
  );

  await client.query("DELETE FROM matrix_refs WHERE system_id = $1 AND ref_type IN ('Document'::ref_type, 'Skill'::ref_type)", [systemId]);
  await client.query("DELETE FROM documents WHERE system_id = $1 AND kind IN ('Document'::doc_kind, 'Skill'::doc_kind)", [systemId]);
  await client.query("DELETE FROM edges WHERE system_id = $1", [systemId]);
  await client.query("DELETE FROM artifacts WHERE system_id = $1", [systemId]);
  await client.query("DELETE FROM nodes WHERE system_id = $1", [systemId]);
  await client.query("DELETE FROM concerns WHERE system_id = $1 AND scope IS DISTINCT FROM 'system'", [systemId]);

  for (const [index, concern] of concernNames.entries()) {
    await client.query(
      `INSERT INTO concerns (system_id, name, position, is_baseline)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (system_id, name) DO UPDATE
         SET position = EXCLUDED.position,
             is_baseline = EXCLUDED.is_baseline`,
      [systemId, concern, index],
    );
  }

  for (const node of parsed.nodes) {
    await client.query(
      `INSERT INTO nodes (id, system_id, kind, name, parent_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (system_id, id) DO UPDATE
         SET kind = EXCLUDED.kind,
             name = EXCLUDED.name,
             parent_id = EXCLUDED.parent_id,
             metadata = EXCLUDED.metadata,
             updated_at = now()`,
      [node.id, systemId, node.kind, node.name, node.parentId ?? null, node.metadata],
    );

    for (const artifactId of node.summaryArtifactIds) {
      const summary = parsed.summaryArtifacts.find((entry) => entry.id === artifactId);
      if (!summary) {
        throw new Error(`Missing summary artifact file for ${artifactId}.`);
      }
      await upsertDocumentArtifacts(client, systemId, summary);
    }

    for (const artifactId of node.docsArtifactIds) {
      const docs = parsed.docsArtifacts.find((entry) => entry.id === artifactId);
      if (!docs) {
        throw new Error(`Missing docs artifact file for ${artifactId}.`);
      }
      await upsertDocumentArtifacts(client, systemId, docs);
    }

    for (const artifact of node.codeArtifacts) {
      await client.query(
        `INSERT INTO artifacts (id, system_id, node_id, concern, type, language)
         VALUES ($1, $2, $3, $4, 'Code'::artifact_type, $5)
         ON CONFLICT (system_id, id) DO UPDATE
           SET node_id = EXCLUDED.node_id,
               concern = EXCLUDED.concern,
               language = EXCLUDED.language,
               text = NULL,
               updated_at = now()`,
        [artifact.id, systemId, node.id, artifact.concern, "en"],
      );

      for (const filePath of artifact.files) {
        const normalized = normalizePath(filePath);
        const fileContent = parsed.codeArtifactFiles.get(normalized);
        if (fileContent === undefined) {
          throw new Error(`Missing code artifact file ${filePath} for artifact ${artifact.id}.`);
        }

        const fileHashResult = await client.query<{ upsert_file_content: string }>(
          `SELECT upsert_file_content($1, $2) AS upsert_file_content`,
          [normalized, fileContent],
        );
        const fileHash = fileHashResult.rows[0]?.upsert_file_content;
        if (!fileHash) {
          throw new Error(`Failed to upsert file ${filePath} for artifact ${artifact.id}.`);
        }

        await client.query(
          `INSERT INTO artifact_files (system_id, artifact_id, file_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (system_id, artifact_id, file_hash) DO NOTHING`,
          [systemId, artifact.id, fileHash],
        );
      }
    }
  }

  for (const document of parsed.documents) {
    await client.query(
      `INSERT INTO documents (hash, system_id, kind, title, language, source_type, text, supersedes)
       VALUES ($1, $2, $3::doc_kind, $4, $5, 'local'::doc_source_type, $6, $7)
       ON CONFLICT (system_id, hash) DO UPDATE
         SET kind = EXCLUDED.kind,
             title = EXCLUDED.title,
             language = EXCLUDED.language,
             text = EXCLUDED.text,
             supersedes = EXCLUDED.supersedes`,
      [document.hash, systemId, document.kind, document.title, document.language, document.text, document.supersedes],
    );
  }

  for (const node of parsed.nodes) {
    for (const concern of Object.keys(node.matrix)) {
      if (!concern || concern === SYSTEM_PROMPT_CONCERN) {
        continue;
      }
      await upsertMatrixRefs(client, systemId, node, concern);
    }
  }

  const rootPromptRefs = appendSystemPromptRefs(parsed.nodes, parsed.manifest, resolvedSystemNodeId);
  await ensurePromptDocsExist(client, systemId, resolvedSystemNodeId, rootPromptRefs);

  for (const edge of parsed.edges) {
    await client.query(
      `INSERT INTO edges (id, system_id, type, from_node_id, to_node_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (system_id, id) DO UPDATE
         SET type = EXCLUDED.type,
             from_node_id = EXCLUDED.from_node_id,
             to_node_id = EXCLUDED.to_node_id,
             metadata = EXCLUDED.metadata`,
      [edge.id, systemId, edge.type, edge.fromNodeId, edge.toNodeId, edge.metadata],
    );
  }

  return systemId;
}

export async function applyOpenShipBundleToThreadSystem(input: ApplyOpenShipSyncInput): Promise<string> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const systemId = await applyOpenShipBundleToThreadSystemWithClient(client, input);
    await client.query("COMMIT");
    return systemId;
  } catch (error: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release?.();
  }
}
