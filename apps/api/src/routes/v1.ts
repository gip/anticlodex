import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import {
  OpenShipValidationError,
  normalizeOpenShipOrigin,
  validateDiscovery,
  validateSources,
} from "@openship/protocol";

import pool, { query } from "../db.js";
import { generateOpenShipFileBundle } from "../agent-runner.js";
import { verifyAuth, verifyOptionalAuth, type AuthUser } from "../auth.js";
import { SQL_LIKE_ESCAPE_CHARACTER, toLikeContainsPattern } from "../sql-like.js";
import {
  buildDocumentAddSummary,
  buildDocumentCreateSummary,
  buildDocumentModifySummary,
  buildDocumentRemoveSummary,
  buildDocumentText,
  computeDocumentHash,
  deriveDocumentName,
  isValidDocumentName,
  normalizeMatrixDocumentCreateBody,
  normalizeMatrixDocumentReplaceBody,
  normalizeMatrixRefBody,
  parseDocumentText,
  type DocKind,
  type MatrixRefPayload,
} from "../documents.js";
import { fetchRemoteDocument, isIntegrationReconnectError } from "../integrations/tokens.js";
import { isNotionApiError } from "../integrations/notion.js";
import {
  claimAgentRunById,
  enqueueAgentRunWithWait,
  getAgentRunById,
  updateAgentRunResult,
} from "../agent-queue.js";
import {
  applyOpenShipBundleToThreadSystem,
  applyOpenShipBundleToThreadSystemWithClient,
} from "../openship-sync.js";
import type { AgentRunPlanChange } from "@acx/agent-runtime";
import {
  publishEvent,
  queryEvents,
  encodeCursor,
  parseCursor,
} from "../events.js";
import {
  BLANK_TEMPLATE_ID,
  DEFAULT_CONCERNS,
  getTemplateById,
  isKnownTemplateId,
  type TemplateDefinition,
  type TemplateDocument,
} from "../templates/index.js";
import {
  emptySources,
  exportSources,
  exportSourcesDigest,
  exportSystems,
  persistSources,
  populateOpenShipSystem,
  verifyImportSnapshot,
} from "../openship-v1.js";

type AccessRole = "Owner" | "Editor" | "Viewer";
type V1OpenShipNodeKind = "Root" | "Host" | "Container" | "Process" | "Library";

const OPENSHIP_ROOT_NODE_ID = "s.root";
const TYPED_NODE_ID_SCHEME = "typed_key_v1";
const OPENSHIP_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function kindToPrefix(kind: V1OpenShipNodeKind): string {
  if (kind === "Root") return "s";
  if (kind === "Host") return "h";
  if (kind === "Container") return "c";
  if (kind === "Process") return "p";
  return "l";
}

function normalizeOpenShipKey(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!OPENSHIP_KEY_PATTERN.test(normalized)) {
    throw new Error(`Invalid OpenShip key "${raw}".`);
  }
  return normalized;
}

function buildTypedNodeId(kind: V1OpenShipNodeKind, key: string): string {
  if (kind === "Root") return OPENSHIP_ROOT_NODE_ID;
  return `${kindToPrefix(kind)}.${key}`;
}

function computeTemplateDocumentHash(document: Pick<TemplateDocument, "kind" | "title" | "language" | "text">): string {
  const payload = [document.kind, document.title, document.language, document.text].join("\n");
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function resolveTemplateBundlePath(bundlePath: string): string {
  const override = process.env.ACX_TEMPLATE_BUNDLE_PATH?.trim();
  if (override) return resolve(override);

  const direct = resolve(process.cwd(), bundlePath);
  const workspaceRoot = resolve(process.cwd(), "..", "..", bundlePath);
  if (existsSync(direct)) return direct;
  if (existsSync(workspaceRoot)) return workspaceRoot;
  return direct;
}

async function seedSystemConcernsV1(
  client: PoolClient,
  systemId: string,
  concerns: Array<{ name: string; position: number; isBaseline: boolean; scope?: string | null }>,
): Promise<void> {
  for (const concern of concerns) {
    await client.query(
      `INSERT INTO concerns (system_id, name, position, is_baseline, scope)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (system_id, name) DO NOTHING`,
      [systemId, concern.name, concern.position, concern.isBaseline, concern.scope ?? null],
    );
  }
}

async function seedSystemTemplateV1(
  client: PoolClient,
  systemId: string,
  rootNodeId: string,
  template: TemplateDefinition,
): Promise<void> {
  const nodeIds = new Map<string, string>([["root", rootNodeId]]);
  const nodeOpenShipKeys = new Map<string, string>();
  const nodeIdToTemplateKey = new Map<string, string>();

  for (const node of template.nodes) {
    if (nodeIds.has(node.key)) {
      throw new Error(`Template "${template.id}" has duplicate node key "${node.key}"`);
    }

    const openShipKey = normalizeOpenShipKey(node.key);
    const typedNodeId = buildTypedNodeId(node.kind, openShipKey);
    const existingTemplateKey = nodeIdToTemplateKey.get(typedNodeId);
    if (existingTemplateKey) {
      throw new Error(
        `Template "${template.id}" has node id collision after normalization: ` +
          `"${existingTemplateKey}" and "${node.key}" both map to "${typedNodeId}"`,
      );
    }

    nodeIds.set(node.key, typedNodeId);
    nodeOpenShipKeys.set(node.key, openShipKey);
    nodeIdToTemplateKey.set(typedNodeId, node.key);
  }

  for (const node of template.nodes) {
    const nodeId = nodeIds.get(node.key);
    const openShipKey = nodeOpenShipKeys.get(node.key);
    const parentKey = node.parentKey ?? "root";
    const parentNodeId = nodeIds.get(parentKey);

    if (!nodeId || !parentNodeId || !openShipKey) {
      throw new Error(
        `Template "${template.id}" references unknown parent "${parentKey}" for node "${node.key}"`,
      );
    }

    const nodeMetadata = {
      ...node.metadata,
      ...(node.layout ? { layout: node.layout } : {}),
      openshipKey: openShipKey,
    };

    await client.query(
      `INSERT INTO nodes (id, system_id, kind, name, parent_id, metadata)
       VALUES ($1, $2, $3::node_kind, $4, $5, $6::jsonb)`,
      [nodeId, systemId, node.kind, node.name, parentNodeId, JSON.stringify(nodeMetadata)],
    );
  }

  for (const edge of template.edges) {
    const fromNodeId = nodeIds.get(edge.fromKey);
    const toNodeId = nodeIds.get(edge.toKey);
    if (!fromNodeId || !toNodeId) {
      throw new Error(
        `Template "${template.id}" edge references unknown nodes "${edge.fromKey}" -> "${edge.toKey}"`,
      );
    }

    const metadata = edge.protocol ? JSON.stringify({ protocol: edge.protocol }) : "{}";
    await client.query(
      `INSERT INTO edges (id, system_id, type, from_node_id, to_node_id, metadata)
       VALUES ($1, $2, $3::edge_type, $4, $5, $6::jsonb)`,
      [randomUUID(), systemId, edge.type, fromNodeId, toNodeId, metadata],
    );
  }

  await seedSystemConcernsV1(client, systemId, template.concerns);
  const concernNames = new Set(template.concerns.map((concern) => concern.name));

  const documentHashes = new Map<string, string>();
  for (const document of template.documents) {
    if (documentHashes.has(document.key)) {
      throw new Error(`Template "${template.id}" has duplicate document key "${document.key}"`);
    }

    const hash = computeTemplateDocumentHash(document);
    documentHashes.set(document.key, hash);
    await client.query(
      `INSERT INTO documents (hash, system_id, kind, title, language, text)
       VALUES ($1, $2, $3::doc_kind, $4, $5, $6)
       ON CONFLICT (system_id, hash) DO NOTHING`,
      [hash, systemId, document.kind, document.title, document.language, document.text],
    );
  }

  for (const ref of template.matrixRefs) {
    const nodeId = nodeIds.get(ref.nodeKey);
    const docHash = documentHashes.get(ref.documentKey);
    if (!nodeId) {
      throw new Error(`Template "${template.id}" matrix ref references unknown node "${ref.nodeKey}"`);
    }
    if (!docHash) {
      throw new Error(
        `Template "${template.id}" matrix ref references unknown document "${ref.documentKey}"`,
      );
    }
    if (!concernNames.has(ref.concern)) {
      throw new Error(`Template "${template.id}" matrix ref references unknown concern "${ref.concern}"`);
    }

    await client.query(
      `INSERT INTO matrix_refs (system_id, node_id, concern, ref_type, doc_hash)
       VALUES ($1, $2, $3, $4::ref_type, $5)
       ON CONFLICT DO NOTHING`,
      [systemId, nodeId, ref.concern, ref.refType, docHash],
    );
  }
}

interface V1AuthRequest extends FastifyRequest {
  auth: AuthUser;
}

function getOptionalAuthUser(req: FastifyRequest): AuthUser | null {
  return (req as FastifyRequest & { auth?: AuthUser }).auth ?? null;
}

type CursorLike = string | undefined;

interface V1ProjectAccessRow {
  project_id: string;
  owner_id: string;
  visibility: "public" | "private";
  owner_handle: string;
  is_archived: boolean;
  access_role: AccessRole;
  name: string;
}

interface V1ThreadSummaryRow {
  id: string;
  project_thread_id: number | null;
  title: string | null;
  description: string | null;
  source_thread_id: string | null;
  project_id: string;
  project_name: string;
  status: "open" | "closed" | "committed";
  created_by_handle: string;
  owner_handle: string;
  created_at: Date;
  updated_at: Date;
  access_role: AccessRole;
}

interface V1ThreadMatrixNodeCell {
  nodeId: string;
  concern: string;
  docs: Array<{
    hash: string;
    title: string;
    kind: string;
    language: string;
    sourceType: string;
    sourceUrl: string | null;
    sourceExternalId: string | null;
    sourceMetadata: Record<string, unknown> | null;
    sourceConnectedUserId: string | null;
    refType: string;
  }>;
  artifacts: Array<{
    path: string;
    type: string;
    metadata: Record<string, unknown>;
  }>;
}

interface V1TopologyNode {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
  layoutX?: number | null;
  layoutY?: number | null;
  ownership: "first_party" | "third_party";
  boundary: "internal" | "external";
}

interface V1TopologyEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: string;
  protocol?: string | null;
  layer7?: string | null;
}

interface V1RunChatMessage {
  id: string;
  actionId: string;
  actionType: string;
  actionPosition: number;
  role: "User" | "Assistant" | "System";
  content: string;
  senderName?: string;
  createdAt: string;
}

interface V1OpenShipBundleFile {
  path: string;
  content: string;
}

interface RawOpenShipBundleFilePayload {
  path?: unknown;
  content?: unknown;
}

interface V1OpenShipBundleDescriptor {
  threadId: string;
  systemId: string;
  generatedAt: string;
  files: V1OpenShipBundleFile[];
}

type V1IntegrationStatus = "connected" | "disconnected" | "expired" | "needs_reauth";
type V1ProjectVisibility = "public" | "private";
type V1ProjectRole = "Owner" | "Editor" | "Viewer";

interface V1ProjectListRow {
  id: string;
  name: string;
  description: string | null;
  visibility: V1ProjectVisibility;
  access_role: V1ProjectRole;
  owner_handle: string;
  created_at: Date;
  thread_count: string;
}

interface V1ProjectThreadsListRow {
  project_id: string;
  id: string;
  project_thread_id: number | null;
  title: string | null;
  description: string | null;
  source_thread_id: string | null;
  status: V1ThreadStatus;
  created_at: Date;
  updated_at: Date;
}

type AssistantMode = "direct" | "plan";
type AssistantRunStatus = "queued" | "running" | "success" | "failed" | "cancelled";

interface V1ThreadRow {
  id: string;
  project_id: string;
  title: string | null;
  description: string | null;
  status: "open" | "closed" | "committed";
  created_at: Date;
  updated_at: Date;
  source_thread_id: string | null;
  access_role: AccessRole;
}

interface V1ProjectThreadConcernRow {
  name: string;
  position: number;
}

interface V1ThreadDocumentMetadataRow {
  hash: string;
  kind: string;
  title: string;
  language: string;
  source_type: string;
  source_url: string | null;
  source_external_id: string | null;
  source_metadata: Record<string, unknown> | null;
  source_connected_user_id: string | null;
}

interface V1ProjectThreadDocumentRow extends V1ThreadDocumentMetadataRow {
  text: string;
}

interface V1ChatMessageRow {
  content: string;
}

interface V1ChatMessage {
  id: string;
  actionId: string;
  role: "User" | "Assistant" | "System";
  actionType: string;
  actionPosition: number;
  content: string;
  createdAt: string;
}

interface V1SystemPromptRow {
  hash: string;
  text: string;
  title: string;
}

interface V1AgentRunRow {
  id: string;
  thread_id: string;
  model: string;
  status: AssistantRunStatus;
  mode: AssistantMode;
  prompt: string;
  system_prompt: string | null;
  run_result_status: "success" | "failed" | null;
  run_result_messages: string[] | null;
  run_result_changes: AgentRunPlanChange[] | null;
  run_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface V1ChatMessageRequest {
  content?: string;
  role?: "User" | "Assistant" | "System";
}

interface V1RunStartBody {
  prompt?: string;
  chatMessageId?: string;
  model?: string;
  wait?: boolean;
  status?: string;
  sourceThreadId?: string;
}

const CODEX_MODEL = "gpt-5.3-codex";
const LEGACY_CODEX_MODEL = "codex-5.3";
const CLAUDE_OPUS_4_7_MODEL = "claude-opus-4-7";
const GPT_5_5_MODEL = "gpt-5.5";
const GPT_5_4_MODEL = "gpt-5.4";
const ALLOWED_ASSISTANT_MODELS = ["claude-opus-4-6", CLAUDE_OPUS_4_7_MODEL, "claude-sonnet-4-6", CODEX_MODEL, LEGACY_CODEX_MODEL, GPT_5_5_MODEL, GPT_5_4_MODEL] as const;
const DEFAULT_ASSISTANT_MODEL: "claude-opus-4-6" | "claude-opus-4-7" | "claude-sonnet-4-6" | "codex-5.3" | "gpt-5.3-codex" | "gpt-5.5" | "gpt-5.4" = "claude-opus-4-6";
const SYSTEM_PROMPT_CONCERN = "__system_prompt__";
const DEFAULT_SYSTEM_PROMPT =
  "You are a staff software engineer with top design and implementation skills. " +
  "Start by reading AGENTS.md. " +
  "You will update the system description and implementation in ./openship (or not if there is no update) " +
  "and add to a file called SUMMARY.md a description of the plan executed, use Markdown. " +
  "If changes were made during the run, check that the updated ./openship directory is fully compliant with the OpenShip description and write that you checked that in the summary. " +
  "If changes are to be made, keep the changes to a minimum. In particular do not update name if existing objects like node or names unless it is absolutely necessary. " +
  "Node IDs and directory names should not be changed " +
  "Your response should be a summary of everything that has been done. No need to include checks and validation made.";
type AssistantModel = (typeof ALLOWED_ASSISTANT_MODELS)[number];

function resolveAssistantModel(raw: unknown): AssistantModel | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (normalized.length === 0) return null;
  return ALLOWED_ASSISTANT_MODELS.includes(normalized as AssistantModel) ? (normalized as AssistantModel) : null;
}

function normalizeAssistantModel(rawModel: AssistantModel): AssistantModel {
  return rawModel === CODEX_MODEL ? LEGACY_CODEX_MODEL : rawModel;
}

function formatAssistantModelLabel(rawModel: string): string {
  const model = rawModel.trim();
  if (model === "gpt-5.3-codex") return "Codex 5.3";
  if (model === "codex-5.3") return "Codex 5.3";
  if (model === "gpt-5.5") return "GPT 5.5";
  if (model === "gpt-5.4") return "GPT 5.4";
  if (model === "claude-opus-4-7") return "Claude Opus 4.7";
  if (model === "claude-opus-4-6") return "Claude Opus 4.6";
  if (model === "claude-sonnet-4-6") return "Claude Sonnet 4.6";
  return model;
}

type V1ThreadStatus = "open" | "closed" | "committed";

interface V1ThreadPatchBody {
  title?: string;
  description?: string | null;
  status?: V1ThreadStatus;
}

interface V1ThreadScopeQuerystring {
  projectId?: string;
  // A numeric threadId is only unique within a project, so it needs a scope. A
  // client that routes by /:handle/:projectName/:threadId can pass the handle and
  // project name straight through instead of first resolving them to a projectId.
  handle?: string;
  projectName?: string;
}

interface V1RunClaimBody {
  runnerId?: string;
}

interface V1RunCompleteBody {
  status: "success" | "failed";
  messages: string[];
  changes?: Array<Record<string, unknown>>;
  error?: string;
  runnerId?: string;
  openShipBundleFiles?: unknown;
}

interface V1MatrixPatchBody {
  layout?: Array<{ nodeId: string; x: number; y: number }>;
  nodes?: Array<{ nodeId: string; x: number; y: number }>;
  positions?: Array<{ nodeId: string; x: number; y: number }>;
}

interface V1ListCursor {
  page: number;
  pageSize: number;
  nextCursor: string | null;
}

function writeProblem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
  code?: string,
): void {
  reply.code(status).type("application/problem+json").send({
    type: "https://tools.ietf.org/html/rfc7807#section-3.1",
    title,
    status,
    detail,
    instance: reply.request.url,
    ...(code ? { code } : {}),
  });
}

function forbiddenProblem(reply: FastifyReply, detail = "You do not have access to this resource."): void {
  writeProblem(reply, 403, "Forbidden", detail);
}

function notFoundProblem(reply: FastifyReply, title = "Not found"): void {
  writeProblem(reply, 404, title, title);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readEventCursor(raw: CursorLike): CursorLike {
  if (!raw) return undefined;
  try {
    const decoded = decodeURIComponent(raw);
    if (parseCursor(decoded)) return decoded;
    const parsedDate = new Date(decoded);
    if (!Number.isNaN(parsedDate.getTime())) return decoded;
    return undefined;
  } catch {
    return undefined;
  }
}

function parsePositiveInt(raw: unknown, fallback: number, min = 1, max = 200): number {
  const asNumber = typeof raw === "number" || typeof raw === "string"
    ? Number(raw)
    : NaN;
  if (!Number.isFinite(asNumber)) return fallback;
  const value = Math.trunc(asNumber);
  if (value < min) return fallback;
  return value > max ? max : value;
}

function normalizeToplologyPositions(body: V1MatrixPatchBody): Array<{ nodeId: string; x: number; y: number }> {
  const list = body.layout ?? body.nodes ?? body.positions;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry): entry is { nodeId: string; x: number; y: number } => {
      if (!entry || typeof entry !== "object") return false;
      const xValue = typeof entry.x === "string" ? Number(entry.x) : entry.x;
      const yValue = typeof entry.y === "string" ? Number(entry.y) : entry.y;
      return (
        typeof entry.nodeId === "string"
        && entry.nodeId.trim().length > 0
        && Number.isFinite(xValue)
        && Number.isFinite(yValue)
      );
    })
    .map((entry) => ({
      nodeId: entry.nodeId.trim(),
      x: typeof entry.x === "string" ? Number(entry.x) : entry.x,
      y: typeof entry.y === "string" ? Number(entry.y) : entry.y,
    }));
}

function parseProjectThreadId(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseOptionalProjectId(raw: unknown): string | null | "invalid" {
  if (typeof raw === "undefined") return null;
  if (typeof raw !== "string") return "invalid";
  const trimmed = raw.trim();
  if (!trimmed) return "invalid";
  return isUuid(trimmed) ? trimmed : "invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAgentRunPlanChange(value: unknown): value is AgentRunPlanChange {
  if (!isRecord(value)) return false;
  const candidate = value as {
    target_table?: unknown;
    operation?: unknown;
    target_id?: unknown;
    previous?: unknown;
    current?: unknown;
  };
  if (typeof candidate.target_table !== "string") return false;
  if (candidate.operation !== "Create" && candidate.operation !== "Update" && candidate.operation !== "Delete") return false;
  if (!isRecord(candidate.target_id)) return false;
  if (candidate.previous !== null && !isRecord(candidate.previous)) return false;
  if (candidate.current !== null && !isRecord(candidate.current)) return false;
  return true;
}

function parseRunPlanChanges(raw: unknown): AgentRunPlanChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isAgentRunPlanChange);
}

function parseOpenShipBundleFiles(value: unknown): V1OpenShipBundleFile[] | null {
  if (value === undefined) return [];

  if (!Array.isArray(value)) return null;

  const files: V1OpenShipBundleFile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;

    const candidate = entry as RawOpenShipBundleFilePayload;
    if (typeof candidate.path !== "string" || typeof candidate.content !== "string") {
      return null;
    }

    files.push({
      path: candidate.path,
      content: candidate.content,
    });
  }

  return files;
}

function extractV1AgentRunMessageText(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return [];

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractV1AgentRunMessageText(entry, depth + 1));
  }

  if (typeof value === "object") {
    const typed = value as Record<string, unknown>;

    if (typeof typed.text === "string") {
      return [typed.text];
    }

    const candidates = [
      typed.content,
      typed.message,
      typed.response,
      typed.result,
      typed.summary,
      typed.output,
      typed.aggregated_output,
      typed.items,
    ];

    return candidates.flatMap((entry) => extractV1AgentRunMessageText(entry, depth + 1));
  }

  return [];
}

function normalizeV1AgentRunMessages(messages: string[]): string[] {
  const unique = new Set<string>();
  const normalized: string[] = [];

  for (const rawMessage of messages) {
    const trimmed = rawMessage.trim();
    if (!trimmed) continue;

    const withoutPrefix = trimmed.replace(/^\[[^\]]+\]\s*/g, "");

    let candidateTexts: string[] = [];
    try {
      const parsed = JSON.parse(withoutPrefix) as unknown;
      candidateTexts = extractV1AgentRunMessageText(parsed)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    } catch {
      candidateTexts = [trimmed];
    }

    for (const text of candidateTexts) {
      if (!unique.has(text)) {
        unique.add(text);
        normalized.push(text);
      }
    }
  }

  return normalized.length > 0 ? normalized : ["Execution completed."];
}

const RECONCILIATION_MESSAGE_PREFIX = "openship reconciliation failed:";

function sanitizeV1AgentRunMessages(messages: string[]): string[] {
  return normalizeV1AgentRunMessages(messages)
    .map((message) => message.trim())
    .filter((message) => message.length > 0)
    .filter((message) => !message.toLowerCase().startsWith(RECONCILIATION_MESSAGE_PREFIX));
}

interface V1AgentRunCompletionRecord {
  responseActionId: string | null;
}

async function persistV1DesktopAgentRunCompletionMessage(
  threadId: string,
  payload: { status: "success" | "failed"; messages: string[]; changes: AgentRunPlanChange[]; error?: string },
  runResultStatus: "success" | "failed",
): Promise<V1AgentRunCompletionRecord | null> {
  const responseActionId = randomUUID();
  const normalizedMessages = sanitizeV1AgentRunMessages(payload.messages);
  const nonChangeMessages = normalizedMessages.filter((message) => !message.startsWith("OpenShip changes:"));

  const responseMessages = nonChangeMessages.length > 0
    ? nonChangeMessages
    : payload.changes.length > 0
      ? normalizedMessages
      : [
          ...nonChangeMessages,
          payload.status === "failed"
            ? (payload.error ?? "Execution failed.")
            : "Execution completed.",
        ];

  const uniqueResponseMessages = [...new Set(responseMessages)];
  if (uniqueResponseMessages.length === 0) {
    return null;
  }

  const responseMessage = uniqueResponseMessages.join(" | ");
  await query(
    `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
    [threadId, responseActionId, "ExecuteResponse", "Agent execution response"],
  );
  await query("SELECT commit_action_empty($1, $2)", [threadId, responseActionId]);
  await query(
    `INSERT INTO messages (id, thread_id, action_id, role, content, position)
     VALUES ($1, $2, $3, 'Assistant'::message_role, $4, 1)`,
    [randomUUID(), threadId, responseActionId, responseMessage],
  );

  if (runResultStatus === "success" && payload.changes.length > 0) {
    const changeActionId = randomUUID();
    await query(
      `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
      [threadId, changeActionId, "Update", "Agent execution changes"],
    );
    for (const change of payload.changes) {
      await query(
        `INSERT INTO changes (
           id, thread_id, action_id, target_table, operation, target_id, previous, current
         )
         VALUES ($1, $2, $3, $4, $5::change_operation, $6, $7, $8)`,
        [
          randomUUID(),
          threadId,
          changeActionId,
          change.target_table,
          change.operation,
          JSON.stringify(change.target_id),
          change.previous ? JSON.stringify(change.previous) : null,
          change.current ? JSON.stringify(change.current) : null,
        ],
      );
    }
    await query("SELECT commit_action_empty($1, $2)", [threadId, changeActionId]);
  }

  return { responseActionId };
}

function canEdit(role: AccessRole): boolean {
  return role === "Owner" || role === "Editor";
}

async function resolveProjectAccess(projectId: string, user: AuthUser): Promise<V1ProjectAccessRow | null> {
  const result = await query<V1ProjectAccessRow>(
    `SELECT
       p.id AS project_id,
       p.owner_id,
       p.visibility::text AS visibility,
       owner_u.handle AS owner_handle,
       p.is_archived,
       COALESCE(NULLIF(pc.role::text, ''),
         CASE
           WHEN p.visibility = 'public' THEN 'Viewer'
           WHEN p.owner_id = $2 THEN 'Owner'
           ELSE NULL
         END
       )::text AS access_role,
       p.name
     FROM projects p
     JOIN users owner_u ON owner_u.id = p.owner_id
     LEFT JOIN project_collaborators pc
       ON pc.project_id = p.id
      AND pc.user_id = $2
     WHERE p.id = $1`,
    [projectId, user.id],
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  if (row.is_archived) return null;

  const accessRole = row.access_role as AccessRole | null;
  if (!accessRole) return null;

  return { ...row, access_role: accessRole };
}

async function resolveProjectAccessByHandle(
  handle: string,
  projectName: string,
  user: AuthUser | null,
): Promise<V1ProjectAccessRow | null> {
  const normalizedHandle = handle.trim();
  const normalizedProjectName = projectName.trim();
  const result = await query<V1ProjectAccessRow>(
    `SELECT
       p.id AS project_id,
       p.owner_id,
       p.visibility::text AS visibility,
       owner_u.handle AS owner_handle,
       p.is_archived,
       COALESCE(NULLIF(pc.role::text, ''),
         CASE
           WHEN p.owner_id = $3 THEN 'Owner'
           WHEN p.visibility = 'public' THEN 'Viewer'
           ELSE NULL
         END
       )::text AS access_role,
       p.name
     FROM projects p
     JOIN users owner_u ON owner_u.id = p.owner_id
     LEFT JOIN project_collaborators pc
       ON pc.project_id = p.id
      AND pc.user_id = $3
     WHERE lower(owner_u.handle) = lower($1)
       AND p.name = $2
     LIMIT 1`,
    [normalizedHandle, normalizedProjectName, user?.id ?? null],
  );
  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  if (row.is_archived) return null;

  const accessRole = row.access_role as AccessRole | null;
  if (!accessRole) return null;

  return { ...row, access_role: accessRole };
}

async function resolveProjectSystemId(projectId: string): Promise<string | null> {
  const result = await query<{ system_id: string }>(
    `SELECT thread_current_system(t.id) AS system_id
     FROM threads t
     WHERE t.project_id = $1
     ORDER BY t.project_thread_id ASC
     LIMIT 1`,
    [projectId],
  );
  return result.rows[0]?.system_id ?? null;
}

async function resolveThreadAccess(threadId: string, viewerUserId: string | null): Promise<V1ThreadRow | null> {
  const result = await query<V1ThreadRow>(
    `SELECT
       t.id,
       t.project_id,
       t.title,
       t.description,
       t.status,
       t.created_at,
       t.updated_at,
       t.source_thread_id,
       COALESCE(NULLIF(pc.role::text, ''),
         CASE
           WHEN p.owner_id = CAST($2 AS uuid) THEN 'Owner'
           WHEN p.visibility = 'public' THEN 'Viewer'
           ELSE NULL
         END
       )::text AS access_role
     FROM threads t
     JOIN projects p ON p.id = t.project_id
     JOIN users owner_u ON owner_u.id = p.owner_id
     LEFT JOIN project_collaborators pc
       ON pc.project_id = p.id
      AND pc.user_id = CAST($2 AS uuid)
     WHERE t.id = $1
       AND p.is_archived = false`,
    [threadId, viewerUserId],
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  const accessRole = row.access_role as AccessRole | null;
  if (!accessRole) return null;

  return { ...row, access_role: accessRole };
}

type ThreadAccessResolution =
  | { kind: "found"; thread: V1ThreadRow }
  | { kind: "invalid_thread_id" }
  | { kind: "invalid_project_id" }
  | { kind: "ambiguous_project_thread_id" }
  | { kind: "not_found" };

type ProjectThreadScope =
  | { kind: "id"; projectId: string }
  | { kind: "slug"; handle: string; projectName: string };

function parseProjectSlugScope(scope: V1ThreadScopeQuerystring): ProjectThreadScope | null {
  const handle = typeof scope.handle === "string" ? scope.handle.trim() : "";
  const projectName = typeof scope.projectName === "string" ? scope.projectName.trim() : "";
  if (!handle || !projectName) return null;
  return { kind: "slug", handle, projectName };
}

async function resolveThreadAccessByProjectThreadId(
  projectThreadId: number,
  viewerUserId: string | null,
  scope: ProjectThreadScope | null,
): Promise<ThreadAccessResolution> {
  const params: unknown[] = [projectThreadId, viewerUserId];
  let scopeClause = "";
  if (scope?.kind === "id") {
    scopeClause = `AND t.project_id = $${params.push(scope.projectId)}`;
  } else if (scope?.kind === "slug") {
    scopeClause = `AND p.name = $${params.push(scope.projectName)}
             AND owner_u.handle = $${params.push(scope.handle)}`;
  }

  // Unscoped lookups take two rows so an id that matches several accessible
  // projects can be reported as ambiguous rather than resolving arbitrarily.
  const result = await query<V1ThreadRow>(
    `SELECT *
       FROM (
         SELECT
           t.id,
           t.project_id,
           t.title,
           t.description,
           t.status,
           t.created_at,
           t.updated_at,
           t.source_thread_id,
           COALESCE(NULLIF(pc.role::text, ''),
             CASE
               WHEN p.owner_id = CAST($2 AS uuid) THEN 'Owner'
               WHEN p.visibility = 'public' THEN 'Viewer'
               ELSE NULL
             END
           )::text AS access_role
         FROM threads t
         JOIN projects p ON p.id = t.project_id
         JOIN users owner_u ON owner_u.id = p.owner_id
         LEFT JOIN project_collaborators pc
           ON pc.project_id = p.id
          AND pc.user_id = CAST($2 AS uuid)
         WHERE t.project_thread_id = $1
           AND p.is_archived = false
           ${scopeClause}
       ) accessible
      WHERE accessible.access_role IS NOT NULL
      LIMIT ${scope ? 1 : 2}`,
    params,
  );

  const rowCount = result.rowCount ?? 0;
  if (rowCount === 0) return { kind: "not_found" };
  if (rowCount > 1) return { kind: "ambiguous_project_thread_id" };
  return { kind: "found", thread: result.rows[0] };
}

type V1ThreadRouteId = { kind: "uuid"; id: string } | { kind: "project"; projectThreadId: number };

function parseV1ThreadRouteId(raw: string): V1ThreadRouteId | null {
  const projectThreadId = parseProjectThreadId(raw);
  if (projectThreadId != null) return { kind: "project", projectThreadId };
  if (isUuid(raw)) return { kind: "uuid", id: raw };
  return null;
}

async function resolveThreadAccessByRequestParam(
  rawThreadId: string,
  viewerUserId: string | null,
  scope: V1ThreadScopeQuerystring,
): Promise<ThreadAccessResolution> {
  const parsed = parseV1ThreadRouteId(rawThreadId);
  if (!parsed) return { kind: "invalid_thread_id" };

  if (parsed.kind === "uuid") {
    const byUuid = await resolveThreadAccess(parsed.id, viewerUserId);
    return byUuid ? { kind: "found", thread: byUuid } : { kind: "not_found" };
  }

  const parsedProjectId = parseOptionalProjectId(scope.projectId);
  if (parsedProjectId === "invalid") return { kind: "invalid_project_id" };
  return resolveThreadAccessByProjectThreadId(
    parsed.projectThreadId,
    viewerUserId,
    parsedProjectId ? { kind: "id", projectId: parsedProjectId } : parseProjectSlugScope(scope),
  );
}

function writeThreadAccessFailure(reply: FastifyReply, result: Exclude<ThreadAccessResolution, { kind: "found" }>): void {
  if (result.kind === "invalid_thread_id") {
    writeProblem(reply, 400, "Invalid threadId", "threadId must be a UUID or project thread id.");
    return;
  }
  if (result.kind === "invalid_project_id") {
    writeProblem(reply, 400, "Invalid projectId", "projectId must be a UUID when provided.");
    return;
  }
  if (result.kind === "ambiguous_project_thread_id") {
    writeProblem(
      reply,
      400,
      "Ambiguous threadId",
      "threadId matches multiple accessible projects. Provide projectId query parameter.",
    );
    return;
  }
  notFoundProblem(reply, "Thread not found");
}


async function getThreadSystemId(threadId: string): Promise<string | null> {
  const result = await query<{ system_id: string }>(
    "SELECT thread_current_system($1) AS system_id",
    [threadId],
  );
  return result.rows[0]?.system_id ?? null;
}

async function getSystemPromptsForThreadSystem(threadId: string): Promise<V1SystemPromptRow[]> {
  const systemId = await getThreadSystemId(threadId);
  if (!systemId) return [];

  const result = await query<V1SystemPromptRow>(
    `SELECT d.hash, d.text, d.title
     FROM systems s
     JOIN matrix_refs mr
       ON mr.system_id = s.id
      AND mr.node_id = s.root_node_id
      AND mr.ref_type = 'Prompt'::ref_type
      AND mr.concern = $2
     JOIN documents d
       ON d.system_id = mr.system_id
      AND d.hash = mr.doc_hash
     WHERE s.id = $1
     ORDER BY d.created_at DESC`,
    [systemId, SYSTEM_PROMPT_CONCERN],
  );

  const deduped = new Map<string, V1SystemPromptRow>();
  for (const row of result.rows) {
    if (deduped.has(row.hash)) continue;
    deduped.set(row.hash, row);
  }
  return Array.from(deduped.values());
}

async function resolveSystemPrompt(threadId: string): Promise<string> {
  const prompts = await getSystemPromptsForThreadSystem(threadId);
  const latestPrompt = prompts[0]?.text?.trim();
  return latestPrompt && latestPrompt.length > 0 ? latestPrompt : DEFAULT_SYSTEM_PROMPT;
}

async function resolveRunPrompt(
  threadId: string,
  chatMessageId: string | null,
  prompt?: string,
): Promise<string> {
  const promptFromPayload = prompt?.trim();
  if (promptFromPayload) {
    return promptFromPayload;
  }

  if (chatMessageId) {
    const messageResult = await query<V1ChatMessageRow>(
      `SELECT content
       FROM messages
       WHERE id = $1
         AND thread_id = $2
         AND role = 'User'::message_role
       LIMIT 1`,
      [chatMessageId, threadId],
    );
    const messageContent = messageResult.rows[0]?.content?.trim();
    if (messageContent) return messageContent;
  }

  return "Run this request.";
}

async function loadThreadMatrix(systemId: string): Promise<V1ThreadMatrixNodeCell[]> {
  const result = await query<{
    node_id: string;
    concern: string;
    hash: string;
    title: string;
    kind: string;
    language: string;
    source_type: string;
    source_url: string | null;
    source_external_id: string | null;
    source_metadata: Record<string, unknown> | null;
    source_connected_user_id: string | null;
    ref_type: string;
  }>(
    `SELECT mr.node_id, mr.concern, d.hash, d.title, d.kind::text, d.language,
            d.source_type::text AS source_type, d.source_url, d.source_external_id,
            d.source_metadata, d.source_connected_user_id, mr.ref_type::text AS ref_type
       FROM matrix_refs mr
       JOIN documents d ON d.system_id = mr.system_id AND d.hash = mr.doc_hash
      WHERE mr.system_id = $1
        AND mr.ref_type IN ('Document'::ref_type, 'Skill'::ref_type)`,
    [systemId],
  );

  const byCell = new Map<string, V1ThreadMatrixNodeCell>();
  for (const row of result.rows) {
    const key = `${row.node_id}|${row.concern}`;
    const existing = byCell.get(key);
    const doc = {
      hash: row.hash,
      title: row.title,
      kind: row.kind,
      language: row.language,
      sourceType: row.source_type,
      sourceUrl: row.source_url,
      sourceExternalId: row.source_external_id,
      sourceMetadata: row.source_metadata,
      sourceConnectedUserId: row.source_connected_user_id,
      refType: row.ref_type,
    };

    if (!existing) {
      byCell.set(key, {
      nodeId: row.node_id,
      concern: row.concern,
      docs: [doc],
      artifacts: [],
    });
      continue;
    }

    existing.docs.push(doc);
  }

  return Array.from(byCell.values());
}

function toTopology(nodes: Array<{ id: string; name: string; kind: string; parent_id: string | null; metadata: Record<string, unknown> }> ,
  edges: Array<{ id: string; from_node_id: string; to_node_id: string; type: string; metadata: Record<string, unknown> }>,
): { nodes: V1TopologyNode[]; edges: V1TopologyEdge[] } {
  const normalizeNodeOwnership = (value: unknown): "first_party" | "third_party" =>
    value === "third_party" ? "third_party" : "first_party";
  const normalizeNodeBoundary = (value: unknown): "internal" | "external" =>
    value === "external" ? "external" : "internal";

  const topoNodes = nodes.map((node) => {
    const layout = (node.metadata?.layout as Record<string, unknown>) ?? {};
    const layoutX = typeof layout.x === "number" ? layout.x : null;
    const layoutY = typeof layout.y === "number" ? layout.y : null;
    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      parentId: node.parent_id,
      layoutX,
      layoutY,
      ownership: normalizeNodeOwnership(node.metadata?.ownership),
      boundary: normalizeNodeBoundary(node.metadata?.boundary),
    };
  });

  const topoEdges = edges.map((edge) => ({
    id: edge.id,
    fromNodeId: edge.from_node_id,
    toNodeId: edge.to_node_id,
    type: edge.type,
    protocol: edge.metadata?.protocol ? String(edge.metadata.protocol) : null,
    layer7: edge.metadata?.layer7 ? String(edge.metadata.layer7) : null,
  }));

  return { nodes: topoNodes, edges: topoEdges };
}

async function collectOpenShipBundleFiles(bundleDir: string): Promise<V1OpenShipBundleFile[]> {
  const entries = await readdir(bundleDir, { withFileTypes: true });
  const files: V1OpenShipBundleFile[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = join(bundleDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectOpenShipBundleFiles(childPath);
      for (const nestedFile of nested) {
        const nextPath = `${entry.name}/${nestedFile.path}`.replace(/\\+/g, "/");
        files.push({ path: nextPath, content: nestedFile.content });
      }
      continue;
    }

    if (!entry.isFile()) continue;

    const content = await readFile(childPath, "utf8");
    files.push({
      path: entry.name,
      content,
    });
  }

  return files;
}

function mapAssistantRunRow(run: V1AgentRunRow): {
  runId: string;
  threadId: string;
  model?: string;
  status: AssistantRunStatus;
  mode: AssistantMode;
  prompt: string;
  systemPrompt: string | null;
  runResultStatus: "success" | "failed" | null;
  runResultMessages: string[];
  runResultChanges: unknown[];
  runError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
} {
  return {
    runId: run.id,
    threadId: run.thread_id,
    model: run.model,
    status: run.status,
    mode: run.mode,
    prompt: run.prompt,
    systemPrompt: run.system_prompt,
    runResultStatus: run.run_result_status,
    runResultMessages: run.run_result_messages ?? [],
    runResultChanges: run.run_result_changes ?? [],
    runError: run.run_error,
    createdAt: new Date(run.created_at).toISOString(),
    startedAt: run.started_at ? new Date(run.started_at).toISOString() : null,
    completedAt: run.completed_at ? new Date(run.completed_at).toISOString() : null,
  };
}

async function publishThreadMatrixChanged(threadId: string, user: AuthUser, aggregateId: string): Promise<void> {
  await publishEvent({
    type: "thread.matrix.changed",
    aggregateType: "thread",
    aggregateId,
    orgId: user.orgId,
    traceId: threadId,
    payload: { threadId },
  }).catch(() => undefined);
}

// ============================================================================
// Matrix mutation helpers
//
// Every matrix write goes through begin_action(), which forks the thread's
// current system and returns the fork's id; writes land in the fork, and the
// fork becomes current on COMMIT. commit_action_empty() drops the fork when a
// write turned out to be a no-op, so a redundant request does not leave an
// empty system behind.
// ============================================================================

interface V1MatrixDocumentRow {
  hash: string;
  kind: string;
  title: string;
  language: string;
  text: string;
  source_type: string;
  source_url: string | null;
  source_external_id: string | null;
  source_metadata: Record<string, unknown> | null;
  source_connected_user_id: string | null;
}

function toV1MatrixDocument(row: V1MatrixDocumentRow) {
  return {
    hash: row.hash,
    kind: row.kind,
    title: row.title,
    language: row.language,
    text: row.text,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    sourceExternalId: row.source_external_id,
    sourceMetadata: row.source_metadata,
    sourceConnectedUserId: row.source_connected_user_id,
  };
}

const MATRIX_DOCUMENT_COLUMNS = `hash, kind::text AS kind, title, language, text,
  source_type::text AS source_type, source_url, source_external_id,
  source_metadata, source_connected_user_id`;

async function beginMatrixAction(
  client: PoolClient,
  threadId: string,
  actionId: string,
  actionType: "Edit" | "Import",
  title: string,
): Promise<string> {
  const result = await client.query<{ output_system_id: string }>(
    `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
    [threadId, actionId, actionType, title],
  );
  const outputSystemId = result.rows[0]?.output_system_id;
  if (!outputSystemId) throw new Error("Failed to create action output system");
  return outputSystemId;
}

async function getDocumentTitleByHash(
  client: PoolClient,
  systemId: string,
  hash: string,
): Promise<string | null> {
  const result = await client.query<{ title: string }>(
    `SELECT title FROM documents WHERE system_id = $1 AND hash = $2 LIMIT 1`,
    [systemId, hash],
  );
  return result.rows[0]?.title ?? null;
}

async function getNodeNameById(
  client: PoolClient,
  systemId: string,
  nodeId: string,
): Promise<string | null> {
  const result = await client.query<{ name: string }>(
    `SELECT name FROM nodes WHERE system_id = $1 AND id = $2 LIMIT 1`,
    [systemId, nodeId],
  );
  return result.rows[0]?.name ?? null;
}

async function getNodeNamesByDocumentHash(
  client: PoolClient,
  systemId: string,
  docHash: string,
): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT DISTINCT n.name
       FROM matrix_refs mr
       JOIN nodes n ON n.system_id = mr.system_id AND n.id = mr.node_id
      WHERE mr.system_id = $1 AND mr.doc_hash = $2
      ORDER BY n.name`,
    [systemId, docHash],
  );
  return result.rows.map((row) => row.name);
}

async function insertSystemActionMessage(
  client: PoolClient,
  threadId: string,
  actionId: string,
  content: string,
): Promise<void> {
  await client.query(
    `INSERT INTO messages (id, thread_id, action_id, role, content, position)
     VALUES ($1, $2, $3, 'System'::message_role, $4, 1)`,
    [randomUUID(), threadId, actionId, content],
  );
}

async function getActionMessages(
  client: PoolClient,
  threadId: string,
  actionId: string,
): Promise<V1ChatMessage[]> {
  const result = await client.query<{
    id: string;
    action_id: string;
    action_type: string;
    action_position: number;
    role: "User" | "Assistant" | "System";
    content: string;
    created_at: Date;
  }>(
    `SELECT m.id, m.action_id, m.role, m.content, m.created_at,
            a.position AS action_position, a.type::text AS action_type
       FROM messages m
       JOIN actions a ON a.thread_id = m.thread_id AND a.id = m.action_id
      WHERE m.thread_id = $1 AND m.action_id = $2
      ORDER BY m.position`,
    [threadId, actionId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    actionId: row.action_id,
    role: row.role,
    actionType: row.action_type,
    actionPosition: row.action_position,
    content: row.content,
    createdAt: row.created_at.toISOString(),
  }));
}

async function getSystemRootNodeId(systemId: string, client: PoolClient): Promise<string | null> {
  const result = await client.query<{ root_node_id: string }>(
    `SELECT root_node_id FROM systems WHERE id = $1`,
    [systemId],
  );
  return result.rows[0]?.root_node_id ?? null;
}

// A system prompt is modelled as a Prompt ref on the system root node under one
// reserved concern. The concern is created on demand because it is an internal
// slot rather than something a user adds to the matrix.
async function validateSystemPromptAttachment(
  client: PoolClient,
  systemId: string,
  attachment: { nodeId: string; concerns: string[]; docHash: string },
): Promise<
  | { valid: true; payload: MatrixRefPayload }
  | { valid: false; error: string }
> {
  const rootNodeId = await getSystemRootNodeId(systemId, client);
  if (!rootNodeId) return { valid: false, error: "Unable to resolve system root node" };
  if (attachment.concerns.length !== 1) {
    return { valid: false, error: "System prompts require exactly one concern" };
  }
  if (attachment.concerns[0] !== SYSTEM_PROMPT_CONCERN) {
    return { valid: false, error: `System prompts require concern "${SYSTEM_PROMPT_CONCERN}"` };
  }
  if (attachment.nodeId !== rootNodeId) {
    return { valid: false, error: "System prompts can only be attached to the system root node" };
  }

  await client.query(
    `INSERT INTO concerns (system_id, name, position, is_baseline, scope)
     VALUES ($1, $2, COALESCE((SELECT MAX(position) FROM concerns WHERE system_id = $1), -1) + 1, false, 'system')
     ON CONFLICT DO NOTHING`,
    [systemId, SYSTEM_PROMPT_CONCERN],
  );

  return {
    valid: true,
    payload: {
      nodeId: rootNodeId,
      concern: SYSTEM_PROMPT_CONCERN,
      concerns: [SYSTEM_PROMPT_CONCERN],
      refType: "Prompt",
      docHash: attachment.docHash,
    },
  };
}

async function getSystemPromptsForSystem(systemId: string): Promise<V1SystemPromptRow[]> {
  const result = await query<V1SystemPromptRow>(
    `SELECT d.hash, d.text, d.title
       FROM systems s
       JOIN matrix_refs mr
         ON mr.system_id = s.id
        AND mr.node_id = s.root_node_id
        AND mr.ref_type = 'Prompt'::ref_type
        AND mr.concern = $2
       JOIN documents d ON d.system_id = mr.system_id AND d.hash = mr.doc_hash
      WHERE s.id = $1
      ORDER BY d.created_at DESC`,
    [systemId, SYSTEM_PROMPT_CONCERN],
  );

  const deduped = new Map<string, V1SystemPromptRow>();
  for (const row of result.rows) {
    if (!deduped.has(row.hash)) deduped.set(row.hash, row);
  }
  return Array.from(deduped.values());
}

async function getSystemPromptMetadata(systemId: string): Promise<{
  systemPrompt: string | null;
  systemPromptTitle: string | null;
  systemPrompts: V1SystemPromptRow[];
}> {
  const systemPrompts = await getSystemPromptsForSystem(systemId);
  return {
    systemPrompt: systemPrompts[0]?.text ?? null,
    systemPromptTitle: systemPrompts[0]?.title ?? null,
    systemPrompts,
  };
}

// The cells the client needs after a mutation: only the ones it touched.
// Artifacts are always empty here, matching the thread read, which does not
// surface them either -- returning them only on mutation would make a cell gain
// artifacts on edit and lose them again on the next refresh.
async function getMatrixCellsForNode(
  systemId: string,
  nodeId: string,
  concerns: string[],
): Promise<V1ThreadMatrixNodeCell[]> {
  const wanted = Array.from(new Set(concerns.map((concern) => concern.trim()).filter(Boolean)));
  if (wanted.length === 0) return [];

  const result = await query<{
    node_id: string;
    concern: string;
    hash: string;
    title: string;
    kind: string;
    language: string;
    source_type: string;
    source_url: string | null;
    source_external_id: string | null;
    source_metadata: Record<string, unknown> | null;
    source_connected_user_id: string | null;
    ref_type: string;
  }>(
    `SELECT mr.node_id, mr.concern, d.hash, d.title, d.kind::text AS kind, d.language,
            d.source_type::text AS source_type, d.source_url, d.source_external_id,
            d.source_metadata, d.source_connected_user_id, mr.ref_type::text AS ref_type
       FROM matrix_refs mr
       JOIN documents d ON d.system_id = mr.system_id AND d.hash = mr.doc_hash
      WHERE mr.system_id = $1
        AND mr.node_id = $2
        AND mr.concern = ANY($3::text[])
        AND mr.ref_type IN ('Document'::ref_type, 'Skill'::ref_type)
      ORDER BY mr.ref_type, d.title`,
    [systemId, nodeId, wanted],
  );

  // Every requested concern gets a cell, including the ones that came back with
  // no rows: the client replaces cells by key, so an emptied cell has to be
  // returned as empty rather than omitted, or the removed document lingers.
  const byConcern = new Map<string, V1ThreadMatrixNodeCell>(
    wanted.map((concern) => [concern, { nodeId, concern, docs: [], artifacts: [] }]),
  );
  for (const row of result.rows) {
    byConcern.get(row.concern)?.docs.push({
      hash: row.hash,
      title: row.title,
      kind: row.kind,
      language: row.language,
      sourceType: row.source_type,
      sourceUrl: row.source_url,
      sourceExternalId: row.source_external_id,
      sourceMetadata: row.source_metadata,
      sourceConnectedUserId: row.source_connected_user_id,
      refType: row.ref_type,
    });
  }

  return wanted.map((concern) => byConcern.get(concern)).filter((cell): cell is V1ThreadMatrixNodeCell => Boolean(cell));
}

// The client accepts either `cell` (single) or `cells`; send both when there is
// exactly one so either read path works.
function buildMatrixRefResponse(
  systemId: string,
  cells: V1ThreadMatrixNodeCell[],
  messages: V1ChatMessage[],
  systemPrompt?: Awaited<ReturnType<typeof getSystemPromptMetadata>>,
) {
  return {
    systemId,
    ...(cells.length === 1 ? { cell: cells[0] } : {}),
    cells,
    messages,
    ...(systemPrompt ?? {}),
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The connection is being released either way; a failed rollback here would
    // mask the error that caused it.
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === "23503";
}

const OPTIONAL_AUTH_READ_ROUTES = new Set([
  "/projects",
  "/threads",
  "/threads/:threadId",
  "/threads/:threadId/matrix/documents",
  "/threads/:threadId/matrix/documents/:hash",
]);

export async function v1Routes(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE" && req.url.includes("/projects/imports/openship")) {
      writeProblem(
        reply,
        413,
        "OpenShip import wire payload is too large",
        "The encoded JSON request exceeds the 96 MiB import limit.",
        "openship_wire_too_large",
      );
      return;
    }
    reply.send(error);
  });
  app.addHook("preHandler", async (req, reply) => {
    const routeUrl = req.routeOptions.url;
    // Reads a signed-out visitor may make against a public project. The document
    // routes belong here because bodies used to ride along with the thread read:
    // leaving them out would make a public thread unreadable without an account.
    const isOptionalReadRoute = req.method === "GET"
      && (
        (routeUrl != null && OPTIONAL_AUTH_READ_ROUTES.has(routeUrl.replace(/^\/v1/, "")))
        || routeUrl?.includes("/projects/:handle/:projectName/openship") === true
      );

    if (isOptionalReadRoute) {
      await verifyOptionalAuth(req, reply);
    } else {
      await verifyAuth(req, reply);
    }

    if (reply.sent) return;
  });

  app.addHook("preHandler", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || reply.sent) return;
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const querystring = (req.query ?? {}) as Record<string, unknown>;
    let legacy = false;
    if (params.threadId) {
      const result = await query<{ spec_version: string }>(
        `SELECT s.spec_version FROM systems s WHERE s.id=thread_current_system($1)`,
        [params.threadId],
      );
      legacy = result.rows[0]?.spec_version === "openship/v1";
      if (!result.rows[0] && /^\d+$/.test(params.threadId)) {
        // A numeric thread id needs the request's project scope to resolve, and
        // that scope is either a project id or a handle/projectName pair.
        const scoped = typeof querystring.projectId === "string"
          ? await query<{ spec_version: string }>(
              `SELECT s.spec_version FROM threads t
               JOIN systems s ON s.id=thread_current_system(t.id)
               WHERE t.project_id=$1 AND t.project_thread_id=$2 LIMIT 1`,
              [querystring.projectId, Number(params.threadId)],
            )
          : typeof querystring.handle === "string" && typeof querystring.projectName === "string"
            ? await query<{ spec_version: string }>(
                `SELECT s.spec_version FROM threads t
                 JOIN projects p ON p.id=t.project_id
                 JOIN users owner_u ON owner_u.id=p.owner_id
                 JOIN systems s ON s.id=thread_current_system(t.id)
                 WHERE owner_u.handle=$1 AND p.name=$2 AND t.project_thread_id=$3 LIMIT 1`,
                [querystring.handle, querystring.projectName, Number(params.threadId)],
              )
            : null;
        legacy = scoped?.rows[0]?.spec_version === "openship/v1";
      }
    } else if (params.runId) {
      const result = await query<{ spec_version: string }>(
        `SELECT s.spec_version FROM agent_runs ar
         JOIN systems s ON s.id=thread_current_system(ar.thread_id) WHERE ar.id=$1`,
        [params.runId],
      );
      legacy = result.rows[0]?.spec_version === "openship/v1";
    } else if (typeof body.projectId === "string") {
      const result = await query<{ spec_version: string }>(
        `SELECT s.spec_version FROM threads t
         JOIN systems s ON s.id=thread_current_system(t.id)
         WHERE t.project_id=$1 AND t.source_thread_id IS NULL ORDER BY t.project_thread_id LIMIT 1`,
        [body.projectId],
      );
      legacy = result.rows[0]?.spec_version === "openship/v1";
    } else if (params.handle && params.projectName) {
      const result = await query<{ spec_version: string }>(
        `SELECT s.spec_version FROM projects p
         JOIN users u ON u.id=p.owner_id
         JOIN threads t ON t.project_id=p.id AND t.source_thread_id IS NULL
         JOIN systems s ON s.id=thread_current_system(t.id)
         WHERE u.handle=$1 AND p.name=$2 LIMIT 1`,
        [params.handle, params.projectName],
      );
      legacy = result.rows[0]?.spec_version === "openship/v1";
    }
    if (legacy) {
      writeProblem(
        reply,
        409,
        "Legacy OpenShip project is view-only",
        "Re-import this origin or create an OpenShip 1.0 project before making changes.",
        "legacy_openship_project",
      );
    }
  });

  app.get<{ Querystring: { page?: number; pageSize?: number; name?: string } }>(
    "/projects",
    { config: { anonymousCache: true } },
    async (req) => {
      const viewerUserId = getOptionalAuthUser(req)?.id ?? null;
      const page = parsePositiveInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
      const pageSize = parsePositiveInt(req.query.pageSize, 50, 1, 200);
      const offset = (page - 1) * pageSize;

      const params: Array<unknown> = [viewerUserId, pageSize + 1, offset];
      let nameClause = "";
      if (req.query.name?.trim()) {
        params.push(`%${req.query.name.trim()}%`);
        nameClause = `AND p.name ILIKE $${params.length}`;
      }

      const result = await query<V1ProjectListRow>(
        `SELECT
           p.id,
           p.name,
           p.description,
           p.visibility::text AS visibility,
           CASE
             WHEN p.owner_id = $1 THEN 'Owner'::text
             WHEN pc.role IS NOT NULL THEN pc.role::text
             ELSE 'Viewer'
           END AS access_role,
           owner_u.handle AS owner_handle,
           p.created_at,
           COALESCE((SELECT COUNT(*)::text FROM threads t WHERE t.project_id = p.id), '0') AS thread_count
         FROM projects p
         JOIN users owner_u ON owner_u.id = p.owner_id
         LEFT JOIN project_collaborators pc ON pc.project_id = p.id AND pc.user_id = $1
         WHERE p.is_archived = false
           AND (p.visibility = 'public' OR p.owner_id = $1 OR pc.user_id IS NOT NULL)
           ${nameClause}
         ORDER BY p.created_at DESC
         LIMIT $2
         OFFSET $3`,
        params,
      );

      const hasMore = result.rows.length > pageSize;
      const rows = hasMore ? result.rows.slice(0, pageSize) : result.rows;
      const projectIds = rows.map((row) => row.id);
      const threadRows = projectIds.length
        ? await query<V1ProjectThreadsListRow>(
          `SELECT
             thread_summaries.project_id,
             thread_summaries.id,
             thread_summaries.project_thread_id,
             thread_summaries.title,
             thread_summaries.description,
             thread_summaries.source_thread_id,
             thread_summaries.status::text AS status,
             thread_summaries.created_at,
             thread_summaries.updated_at
           FROM (
             SELECT
               t.project_id,
               t.id,
               t.project_thread_id,
               t.title,
               t.description,
               t.source_thread_id,
               t.status,
               t.created_at,
               t.updated_at,
               ROW_NUMBER() OVER (PARTITION BY t.project_id ORDER BY t.updated_at DESC) AS rank
             FROM threads t
             WHERE t.project_id = ANY($1::text[])
           ) thread_summaries
           WHERE thread_summaries.rank <= 10
           ORDER BY thread_summaries.updated_at DESC`,
          [projectIds],
        )
        : { rows: [] as V1ProjectThreadsListRow[] };

      const threadRowsByProject = new Map<string, Array<{
        id: string;
        projectThreadId: number | null;
        title: string | null;
        description: string | null;
        status: V1ThreadStatus;
        sourceThreadId: string | null;
        createdAt: string;
        updatedAt: string;
      }>>();

      for (const thread of threadRows.rows) {
        const existing = threadRowsByProject.get(thread.project_id) ?? [];
        existing.push({
          id: thread.id,
          projectThreadId: thread.project_thread_id,
          title: thread.title,
          description: thread.description,
          status: thread.status,
          sourceThreadId: thread.source_thread_id,
          createdAt: thread.created_at.toISOString(),
          updatedAt: thread.updated_at.toISOString(),
        });
        threadRowsByProject.set(thread.project_id, existing);
      }

      return {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          visibility: row.visibility,
          accessRole: row.access_role,
          ownerHandle: row.owner_handle,
          createdAt: row.created_at.toISOString(),
          threadCount: Number.parseInt(row.thread_count, 10),
          threads: threadRowsByProject.get(row.id) ?? [],
        })),
        page,
        pageSize,
        nextCursor: hasMore ? String(page + 1) : null,
      };
    },
  );

  app.post<{ Body: { name?: string; description?: string; template?: string; visibility?: V1ProjectVisibility } }>(
    "/projects",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const name = req.body?.name?.trim();
      const description = req.body?.description?.trim() || null;
      const selectedTemplateId = req.body?.template ?? BLANK_TEMPLATE_ID;
      const visibility = req.body?.visibility ?? "private";

      if (!name) {
        return writeProblem(reply, 400, "Invalid name", "name is required.");
      }
      if (visibility !== "public" && visibility !== "private") {
        return writeProblem(reply, 400, "Invalid visibility", "visibility must be public or private.");
      }
      if (!/^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(name) || name.length > 80) {
        return writeProblem(reply, 400, "Invalid project name", "Use a valid project name.");
      }
      if (!isKnownTemplateId(selectedTemplateId)) {
        return writeProblem(reply, 400, "Invalid template", "template must match a known project template.");
      }
      const selectedTemplate = getTemplateById(selectedTemplateId);
      let templateBundleFiles: V1OpenShipBundleFile[] | null = null;
      if (selectedTemplate?.bundleImportPath) {
        const bundlePath = resolveTemplateBundlePath(selectedTemplate.bundleImportPath);
        try {
          templateBundleFiles = await collectOpenShipBundleFiles(bundlePath);
        } catch (error) {
          req.log.error({ error, bundlePath, templateId: selectedTemplate.id }, "Failed to load template bundle");
          return writeProblem(
            reply,
            500,
            "Template bundle unavailable",
            "The selected template could not load its OpenShip bundle.",
          );
        }
      }

      const existing = await query<{ id: string }>(
        "SELECT 1 FROM projects WHERE owner_id = $1 AND name = $2",
        [user.id, name],
      );
      if ((existing.rowCount ?? 0) > 0) {
        return writeProblem(reply, 409, "Duplicate project", "A project with this name already exists.");
      }

      const projectId = randomUUID();
      const threadId = randomUUID();
      const systemId = randomUUID();
      const rootNodeId = OPENSHIP_ROOT_NODE_ID;
      const now = new Date();

      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("BEGIN");
        inTransaction = true;

        await client.query(
          `INSERT INTO projects (id, name, description, visibility, owner_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [projectId, name, description, visibility, user.id],
        );
        await client.query(
          `INSERT INTO systems (id, name, root_node_id, metadata, spec_version)
           VALUES ($1, $2, $3, $4::jsonb, '1.0')`,
          [
            systemId,
            name,
            rootNodeId,
            JSON.stringify({ nodeIdScheme: TYPED_NODE_ID_SCHEME }),
          ],
        );
        await client.query(
          `INSERT INTO nodes (id, system_id, kind, name, parent_id, metadata)
           VALUES ($1, $2, 'Root'::node_kind, $3, NULL, $4::jsonb)`,
          [
            rootNodeId,
            systemId,
            name,
            JSON.stringify({
              openshipKey: "root",
              ownership: "first_party",
              boundary: "internal",
            }),
          ],
        );
        if (selectedTemplate) {
          await seedSystemTemplateV1(client, systemId, rootNodeId, selectedTemplate);
        } else {
          await seedSystemConcernsV1(
            client,
            systemId,
            DEFAULT_CONCERNS.map((concern) => ({
              ...concern,
              scope: null,
            })),
          );
        }
        await client.query(
          "SELECT create_thread($1, $2, $3, $4, $5, $6)",
          [threadId, projectId, user.id, systemId, "Project Creation", description],
        );
        if (templateBundleFiles) {
          await applyOpenShipBundleToThreadSystemWithClient(client, {
            threadId,
            bundleFiles: templateBundleFiles,
          });
        }
        const empty = emptySources({ name, description: description ?? `Anticlodex project ${name}.` });
        const verified = validateSources(empty.manifest, empty.bundle);
        await persistSources(client, verified);
        await client.query(
          `INSERT INTO system_sources (system_id,current_digest,upstream_base_digest)
           VALUES ($1,$2,$2)`,
          [systemId, verified.manifest.digest],
        );

        await client.query("COMMIT");
        inTransaction = false;
      } catch (err) {
        if (inTransaction) {
          await client.query("ROLLBACK").catch(() => {});
        }
        throw err;
      } finally {
        client.release();
      }

      return {
        id: projectId,
        name,
        description,
        visibility,
        accessRole: "Owner" as const,
        ownerHandle: user.handle,
        createdAt: now.toISOString(),
        threadCount: 1,
      };
    },
  );

  app.post<{
    Body: {
      origin?: string;
      name?: string;
      description?: string;
      visibility?: V1ProjectVisibility;
      discovery?: unknown;
      snapshot?: unknown;
    };
  }>(
    "/projects/imports/openship",
    { bodyLimit: 96 * 1024 * 1024 },
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const name = req.body?.name?.trim();
      const description = req.body?.description?.trim();
      const visibility = req.body?.visibility ?? "private";
      if (!name || !/^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(name) || name.length > 80) {
        return writeProblem(reply, 400, "Invalid project name", "Use a valid project name of at most 80 characters.");
      }
      if (!description) return writeProblem(reply, 400, "Invalid description", "description is required.");
      if (visibility !== "public" && visibility !== "private") {
        return writeProblem(reply, 400, "Invalid visibility", "visibility must be public or private.");
      }

      let origin: string;
      let discovery: ReturnType<typeof validateDiscovery>;
      let imported: ReturnType<typeof verifyImportSnapshot>;
      try {
        origin = normalizeOpenShipOrigin(req.body.origin ?? "", { allowLoopbackHttp: true });
        discovery = validateDiscovery(req.body.discovery);
        imported = verifyImportSnapshot(req.body.snapshot);
        if (
          discovery.project.name !== imported.verified.manifest.project.name
          || discovery.project.description !== imported.verified.manifest.project.description
        ) {
          throw new OpenShipValidationError(
            "$.discovery.project",
            "must match the imported Sources project metadata",
            "inconsistent_discovery",
          );
        }
        if (imported.kind === "systems" && !discovery.capabilities.systems) {
          throw new OpenShipValidationError(
            "$.discovery.capabilities.systems",
            "must advertise the imported Systems document",
            "inconsistent_discovery",
          );
        }
      } catch (error) {
        const detail = error instanceof OpenShipValidationError ? error.message : error instanceof Error ? error.message : String(error);
        return writeProblem(
          reply,
          error instanceof OpenShipValidationError && error.code === "source_too_large" ? 413 : 422,
          "Invalid OpenShip import",
          detail,
          error instanceof OpenShipValidationError ? error.code : "invalid_openship_import",
        );
      }

      const existing = await query<{ id: string }>(
        "SELECT id FROM projects WHERE owner_id=$1 AND name=$2",
        [user.id, name],
      );
      if ((existing.rowCount ?? 0) > 0) {
        return writeProblem(reply, 409, "Duplicate project", "A project with this name already exists.");
      }

      const projectId = randomUUID();
      const threadId = randomUUID();
      const systemId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO projects (id,name,description,visibility,owner_id) VALUES ($1,$2,$3,$4,$5)`,
          [projectId, name, description, visibility, user.id],
        );
        await populateOpenShipSystem(client, {
          systemId,
          fallbackName: discovery.project.name,
          origin,
          discovery,
          verified: imported.verified,
          systems: imported.systems,
        });
        await client.query(
          "SELECT create_thread($1,$2,$3,$4,$5,$6)",
          [threadId, projectId, user.id, systemId, "OpenShip Import", `Imported ${origin}`],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        req.log.error({ error, origin }, "OpenShip import failed");
        if ((error as { code?: string }).code === "23505") {
          return writeProblem(reply, 409, "Duplicate project", "A project with this name already exists.");
        }
        return writeProblem(reply, 422, "OpenShip import failed", error instanceof Error ? error.message : String(error));
      } finally {
        client.release();
      }

      return reply.code(201).send({
        id: projectId,
        name,
        description,
        visibility,
        accessRole: "Owner",
        ownerHandle: user.handle,
        createdAt: new Date().toISOString(),
        threadCount: 1,
        threads: [{ id: threadId, title: "OpenShip Import", description: `Imported ${origin}`, status: "open", updatedAt: new Date().toISOString() }],
        openship: {
          origin,
          digest: imported.verified.manifest.digest,
          capability: imported.kind,
          files: imported.verified.manifest.totals.files,
          bytes: imported.verified.manifest.totals.bytes,
        },
      });
    },
  );

  app.get<{ Querystring: { name?: string } }>(
    "/projects/check-name",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const name = req.query.name?.trim();
      if (!name) {
        return writeProblem(reply, 400, "Invalid name", "name is required.");
      }
      const exists = await query(
        "SELECT 1 FROM projects WHERE owner_id = $1 AND name = $2",
        [user.id, name],
      );
      return { available: exists.rowCount === 0 };
    },
  );

  app.get<{ Params: { handle: string; projectName: string } }>(
    "/projects/:handle/:projectName/openship",
    async (req, reply) => {
      const user = getOptionalAuthUser(req);
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      const systemId = await resolveProjectSystemId(project.project_id);
      if (!systemId) return writeProblem(reply, 404, "Project system not found", "Project system not found.");
      const result = await query<{
        spec_version: string; origin: string | null; current_digest: string | null;
        upstream_base_digest: string | null; discovery: Record<string, unknown> | null;
        total_files: string | null; total_bytes: string | null;
      }>(
        `SELECT s.spec_version,ss.origin,ss.current_digest,ss.upstream_base_digest,ss.discovery,
                snap.total_files::text,snap.total_bytes::text
         FROM systems s
         LEFT JOIN system_sources ss ON ss.system_id=s.id
         LEFT JOIN source_snapshots snap ON snap.digest=ss.current_digest
         WHERE s.id=$1`,
        [systemId],
      );
      const row = result.rows[0];
      const files = row.current_digest
        ? await query<{ path: string; encoding: string; file_type: string; media_type: string; target: string | null; size: string }>(
          `SELECT path,encoding,file_type,media_type,target,size::text FROM source_files
           WHERE snapshot_digest=$1 ORDER BY path COLLATE "C"`,
          [row.current_digest],
        )
        : { rows: [] };
      return {
        version: row.spec_version,
        legacy: row.spec_version !== "1.0",
        origin: row.origin,
        currentDigest: row.current_digest,
        upstreamBaseDigest: row.upstream_base_digest,
        discovery: row.discovery,
        validationState: row.spec_version === "1.0" && row.current_digest ? "verified" : "legacy",
        capabilities: (row.discovery?.capabilities as Record<string, unknown> | undefined) ?? null,
        totals: row.total_files === null ? null : { files: Number(row.total_files), bytes: Number(row.total_bytes) },
        files: files.rows.map((file) => ({ ...file, size: Number(file.size) })),
      };
    },
  );

  app.get<{ Params: { handle: string; projectName: string } }>(
    "/projects/:handle/:projectName/openship/upstream.json",
    async (req, reply) => {
      const user = getOptionalAuthUser(req);
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      const systemId = await resolveProjectSystemId(project.project_id);
      if (!systemId) return writeProblem(reply, 404, "Project system not found", "Project system not found.");
      const result = await query<{ upstream_base_digest: string }>(
        "SELECT upstream_base_digest FROM system_sources WHERE system_id=$1",
        [systemId],
      );
      const digest = result.rows[0]?.upstream_base_digest;
      if (!digest) return writeProblem(reply, 409, "OpenShip upstream unavailable", "This project has no upstream base snapshot.");
      try { return await exportSourcesDigest(pool, digest); }
      catch (error) { return writeProblem(reply, 409, "OpenShip upstream unavailable", error instanceof Error ? error.message : String(error)); }
    },
  );

  app.get<{ Params: { handle: string; projectName: string } }>(
    "/projects/:handle/:projectName/openship/remote-changes",
    async (req, reply) => {
      const user = getOptionalAuthUser(req);
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      const systemId = await resolveProjectSystemId(project.project_id);
      if (!systemId) return writeProblem(reply, 404, "Project system not found", "Project system not found.");
      const result = await query<{
        remote_change_id: string | null; base_digest: string; result_digest: string; submit_url: string;
        status_url: string | null; candidate_origin: string | null; status: string; phase: string | null; response: unknown;
      }>(
        `SELECT id,remote_change_id,base_digest,result_digest,submit_url,status_url,candidate_origin,
                status,phase,response,created_at,updated_at
         FROM remote_changes WHERE system_id=$1 ORDER BY created_at DESC`,
        [systemId],
      );
      return { changes: result.rows.map((row) => ({
        remoteChangeId: row.remote_change_id,
        baseDigest: row.base_digest,
        resultDigest: row.result_digest,
        submitUrl: row.submit_url,
        statusUrl: row.status_url,
        candidateOrigin: row.candidate_origin,
        status: row.status,
        phase: row.phase,
        response: row.response,
      })) };
    },
  );

  app.post<{
    Params: { handle: string; projectName: string };
    Body: {
      remoteChangeId?: string | null; baseDigest?: string; resultDigest?: string; submitUrl?: string;
      statusUrl?: string | null; candidateOrigin?: string | null; status?: string; phase?: string | null;
      response?: unknown;
    };
  }>(
    "/projects/:handle/:projectName/openship/remote-changes",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project || !canEdit(project.access_role)) return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      const systemId = await resolveProjectSystemId(project.project_id);
      if (!systemId) return writeProblem(reply, 404, "Project system not found", "Project system not found.");
      const status = req.body?.status;
      if (!status || !["pending", "processing", "ready", "rejected", "failed", "unsupported"].includes(status)) {
        return writeProblem(reply, 400, "Invalid Changes status", "status must be pending, processing, ready, rejected, failed, or unsupported.");
      }
      if (!req.body.baseDigest || !req.body.resultDigest || !req.body.submitUrl) {
        return writeProblem(reply, 400, "Invalid Changes record", "baseDigest, resultDigest, and submitUrl are required.");
      }
      const record = await query(
        `INSERT INTO remote_changes (
           system_id,remote_change_id,base_digest,result_digest,submit_url,status_url,candidate_origin,status,phase,response
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         RETURNING *`,
        [
          systemId,
          req.body.remoteChangeId?.trim() || null,
          req.body.baseDigest,
          req.body.resultDigest,
          req.body.submitUrl,
          req.body.statusUrl ?? null,
          req.body.candidateOrigin ?? null,
          status,
          req.body.phase ?? null,
          JSON.stringify(req.body.response ?? {}),
        ],
      );
      return reply.code(201).send(record.rows[0]);
    },
  );

  app.get<{ Params: { handle: string; projectName: string } }>(
    "/projects/:handle/:projectName/openship/manifest.json",
    async (req, reply) => {
      const user = getOptionalAuthUser(req);
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      const systemId = await resolveProjectSystemId(project.project_id);
      if (!systemId) return writeProblem(reply, 404, "Project system not found", "Project system not found.");
      try { return (await exportSources(pool, systemId)).manifest; }
      catch (error) { return writeProblem(reply, 409, "OpenShip export unavailable", error instanceof Error ? error.message : String(error)); }
    },
  );

  app.get<{ Params: { handle: string; projectName: string } }>(
    "/projects/:handle/:projectName/openship/bundle.json",
    async (req, reply) => {
      const user = getOptionalAuthUser(req);
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      const systemId = await resolveProjectSystemId(project.project_id);
      if (!systemId) return writeProblem(reply, 404, "Project system not found", "Project system not found.");
      try { return (await exportSources(pool, systemId)).bundle; }
      catch (error) { return writeProblem(reply, 409, "OpenShip export unavailable", error instanceof Error ? error.message : String(error)); }
    },
  );

  app.get<{ Params: { handle: string; projectName: string } }>(
    "/projects/:handle/:projectName/openship/system.json",
    async (req, reply) => {
      const user = getOptionalAuthUser(req);
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      const systemId = await resolveProjectSystemId(project.project_id);
      if (!systemId) return writeProblem(reply, 404, "Project system not found", "Project system not found.");
      try { return await exportSystems(pool, systemId); }
      catch (error) { return writeProblem(reply, 409, "OpenShip export unavailable", error instanceof Error ? error.message : String(error)); }
    },
  );

  app.get<{ Params: { handle: string; projectName: string } }>(
    "/projects/:handle/:projectName/collaborators",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }

      const [collabResult, rolesResult] = await Promise.all([
        query<{
          handle: string;
          name: string | null;
          picture: string | null;
          role: string;
          project_roles: string[] | null;
        }>(
          `SELECT u.handle, u.name, u.picture, 'Owner' AS role,
                  ARRAY(SELECT pmr.role_name FROM project_member_roles pmr
                        JOIN project_roles pr ON pr.project_id = pmr.project_id AND pr.name = pmr.role_name
                        WHERE pmr.project_id = $2 AND pmr.user_id = u.id
                        ORDER BY pr.position) AS project_roles
           FROM users u WHERE u.id = $1
           UNION ALL
           SELECT u.handle, u.name, u.picture, pc.role::text AS role,
                  ARRAY(SELECT pmr.role_name FROM project_member_roles pmr
                        JOIN project_roles pr ON pr.project_id = pmr.project_id AND pr.name = pmr.role_name
                        WHERE pmr.project_id = $2 AND pmr.user_id = u.id
                        ORDER BY pr.position) AS project_roles
           FROM project_collaborators pc
           JOIN users u ON u.id = pc.user_id
           WHERE pc.project_id = $2`,
          [project.owner_id, project.project_id],
        ),
        query<{ name: string }>(
          `SELECT name FROM project_roles WHERE project_id = $1 ORDER BY position`,
          [project.project_id],
        ),
      ]);

      const systemId = await resolveProjectSystemId(project.project_id);
      const concernsResult = systemId
        ? await query<{
          name: string;
          position: number;
          is_baseline: boolean;
          scope: string | null;
        }>(
          `SELECT name, position, is_baseline, scope
           FROM concerns
           WHERE system_id = $1
           ORDER BY position`,
          [systemId],
        )
        : { rows: [] as { name: string; position: number; is_baseline: boolean; scope: string | null }[] };

      return {
        accessRole: project.access_role,
        visibility: project.visibility,
        projectRoles: rolesResult.rows.map((row) => row.name),
        concerns: concernsResult.rows.map((row) => ({
          name: row.name,
          position: row.position,
          isBaseline: row.is_baseline,
          scope: row.scope,
        })),
        collaborators: collabResult.rows.map((row) => ({
          handle: row.handle,
          name: row.name,
          picture: row.picture,
          role: row.role,
          projectRoles: row.project_roles ?? [],
        })),
      };
    },
  );

  app.patch<{
    Params: { handle: string; projectName: string };
    Body: { description?: string | null };
  }>(
    "/projects/:handle/:projectName/description",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }
      if (!canEdit(project.access_role)) {
        return forbiddenProblem(reply, "Only the owner or editors can update project description.");
      }
      if (typeof req.body?.description === "undefined") {
        return writeProblem(reply, 400, "Invalid description", "description is required.");
      }
      if (req.body.description !== null && typeof req.body.description !== "string") {
        return writeProblem(reply, 400, "Invalid description", "description must be a string or null.");
      }

      const nextDescription = req.body.description === null
        ? null
        : (req.body.description.trim() || null);
      const result = await query<{ description: string | null }>(
        `UPDATE projects
         SET description = $1
         WHERE id = $2
         RETURNING description`,
        [nextDescription, project.project_id],
      );
      if (result.rowCount === 0) {
        return writeProblem(reply, 404, "Project not found", "Project not found.");
      }

      return { description: result.rows[0].description };
    },
  );

  app.patch<{
    Params: { handle: string; projectName: string };
    Body: { visibility?: V1ProjectVisibility };
  }>(
    "/projects/:handle/:projectName/visibility",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }
      if (project.access_role !== "Owner") {
        return forbiddenProblem(reply, "Only the owner can update visibility.");
      }

      const nextVisibility = req.body?.visibility;
      if (nextVisibility !== "public" && nextVisibility !== "private") {
        return writeProblem(reply, 400, "Invalid visibility", "visibility must be public or private.");
      }

      const result = await query<{ visibility: V1ProjectVisibility }>(
        `UPDATE projects
         SET visibility = $1::project_visibility
         WHERE id = $2
         RETURNING visibility::text AS visibility`,
        [nextVisibility, project.project_id],
      );
      if (result.rowCount === 0) {
        return writeProblem(reply, 404, "Project not found", "Project not found.");
      }

      return { visibility: result.rows[0].visibility };
    },
  );

  app.post<{ Params: { handle: string; projectName: string } }>(
    "/projects/:handle/:projectName/archive",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }
      if (project.access_role !== "Owner") {
        return forbiddenProblem(reply, "Only the owner can archive this project.");
      }

      await query(
        "UPDATE projects SET is_archived = true WHERE id = $1",
        [project.project_id],
      );
      return reply.code(204).send();
    },
  );

  app.post<{
    Params: { handle: string; projectName: string };
    Body: { name?: string };
  }>(
    "/projects/:handle/:projectName/roles",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }
      if (project.access_role !== "Owner") {
        return forbiddenProblem(reply, "Only the owner can manage roles.");
      }

      const roleName = req.body?.name?.trim();
      if (!roleName) {
        return writeProblem(reply, 400, "Invalid role name", "name is required.");
      }

      const maxPos = await query<{ max: number | null }>(
        "SELECT MAX(position) AS max FROM project_roles WHERE project_id = $1",
        [project.project_id],
      );
      const nextPos = (maxPos.rows[0].max ?? -1) + 1;

      try {
        await query(
          "INSERT INTO project_roles (project_id, name, position) VALUES ($1, $2, $3)",
          [project.project_id, roleName, nextPos],
        );
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && (error as { code: string }).code === "23505") {
          return writeProblem(reply, 409, "Duplicate role", "A role with this name already exists.");
        }
        throw error;
      }

      return reply.code(201).send({ name: roleName, position: nextPos });
    },
  );

  app.delete<{ Params: { handle: string; projectName: string; roleName: string } }>(
    "/projects/:handle/:projectName/roles/:roleName",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }
      if (project.access_role !== "Owner") {
        return forbiddenProblem(reply, "Only the owner can manage roles.");
      }

      const roleName = req.params.roleName;
      const assignedCount = await query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM project_member_roles WHERE project_id = $1 AND role_name = $2",
        [project.project_id, roleName],
      );
      if (Number(assignedCount.rows[0].count) > 0) {
        return writeProblem(reply, 409, "Role in use", "Cannot delete role while users are still assigned to it.");
      }

      const result = await query(
        "DELETE FROM project_roles WHERE project_id = $1 AND name = $2",
        [project.project_id, roleName],
      );
      if (result.rowCount === 0) {
        return writeProblem(reply, 404, "Role not found", "Role not found.");
      }
      return reply.code(204).send();
    },
  );

  app.post<{
    Params: { handle: string; projectName: string };
    Body: { name?: string };
  }>(
    "/projects/:handle/:projectName/concerns",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }
      if (project.access_role !== "Owner") {
        return forbiddenProblem(reply, "Only the owner can manage concerns.");
      }

      const concernName = req.body?.name?.trim();
      if (!concernName) {
        return writeProblem(reply, 400, "Invalid concern name", "name is required.");
      }

      const systemId = await resolveProjectSystemId(project.project_id);
      if (!systemId) {
        return writeProblem(reply, 404, "Project system not found", "Project system not found.");
      }

      const positionResult = await query<{ max: number | null }>(
        "SELECT MAX(position) AS max FROM concerns WHERE system_id = $1",
        [systemId],
      );
      const nextPosition = (positionResult.rows[0].max ?? -1) + 1;

      try {
        await query(
          "INSERT INTO concerns (system_id, name, position, is_baseline, scope) VALUES ($1, $2, $3, $4, $5)",
          [systemId, concernName, nextPosition, false, null],
        );
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && (error as { code: string }).code === "23505") {
          return writeProblem(reply, 409, "Duplicate concern", "A concern with this name already exists.");
        }
        throw error;
      }

      return reply.code(201).send({
        name: concernName,
        position: nextPosition,
        isBaseline: false,
        scope: null,
      });
    },
  );

  app.delete<{ Params: { handle: string; projectName: string; concernName: string } }>(
    "/projects/:handle/:projectName/concerns/:concernName",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }
      if (project.access_role !== "Owner") {
        return forbiddenProblem(reply, "Only the owner can manage concerns.");
      }

      const concernName = req.params.concernName;
      const systemId = await resolveProjectSystemId(project.project_id);
      if (!systemId) {
        return writeProblem(reply, 404, "Project system not found", "Project system not found.");
      }

      const [matrixRefs, artifacts] = await Promise.all([
        query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM matrix_refs WHERE system_id = $1 AND concern_hash = md5($2) AND concern = $2",
          [systemId, concernName],
        ),
        query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM artifacts WHERE system_id = $1 AND concern = $2",
          [systemId, concernName],
        ),
      ]);

      const referenced = Number(matrixRefs.rows[0].count) + Number(artifacts.rows[0].count);
      if (referenced > 0) {
        return writeProblem(
          reply,
          409,
          "Concern in use",
          "Cannot delete concern while it is still linked to matrix docs or artifacts.",
        );
      }

      const result = await query(
        "DELETE FROM concerns WHERE system_id = $1 AND name = $2",
        [systemId, concernName],
      );
      if (result.rowCount === 0) {
        return writeProblem(reply, 404, "Concern not found", "Concern not found.");
      }

      return reply.code(204).send();
    },
  );

  app.post<{
    Params: { handle: string; projectName: string };
    Body: { handle?: string; role?: string; projectRoles?: string[] };
  }>(
    "/projects/:handle/:projectName/collaborators",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }
      if (project.access_role !== "Owner") {
        return forbiddenProblem(reply, "Only the owner can add collaborators.");
      }

      const targetHandle = req.body?.handle?.trim();
      if (!targetHandle) {
        return writeProblem(reply, 400, "Invalid collaborator handle", "handle is required.");
      }

      const projectRoles = req.body?.projectRoles;
      if (!projectRoles || !Array.isArray(projectRoles) || projectRoles.length === 0) {
        return writeProblem(reply, 400, "Invalid project roles", "At least one project role is required.");
      }

      const collabRole = req.body?.role === "Viewer" ? "Viewer" : "Editor";
      const userResult = await query<{ id: string; handle: string; name: string | null; picture: string | null }>(
        "SELECT id, handle, name, picture FROM users WHERE lower(handle) = lower($1)",
        [targetHandle],
      );
      if (userResult.rowCount === 0) {
        return writeProblem(reply, 404, "User not found", "User not found.");
      }

      const target = userResult.rows[0];
      if (target.id === project.owner_id) {
        return writeProblem(reply, 400, "Invalid collaborator", "Cannot add the owner as a collaborator.");
      }

      const validRoles = await query<{ name: string }>(
        "SELECT name FROM project_roles WHERE project_id = $1",
        [project.project_id],
      );
      const validSet = new Set(validRoles.rows.map((row) => row.name));
      for (const roleName of projectRoles) {
        if (!validSet.has(roleName)) {
          return writeProblem(reply, 400, "Invalid project role", `Invalid project role: ${roleName}`);
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO project_collaborators (project_id, user_id, role) VALUES ($1, $2, $3::collaborator_role)",
          [project.project_id, target.id, collabRole],
        );
        await client.query(
          `INSERT INTO project_member_roles (project_id, user_id, role_name)
           SELECT $1, $2, unnest($3::text[])`,
          [project.project_id, target.id, projectRoles],
        );
        await client.query("COMMIT");
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof Error && "code" in error && (error as { code: string }).code === "23505") {
          return writeProblem(reply, 409, "Duplicate collaborator", "User is already a collaborator.");
        }
        throw error;
      } finally {
        client.release();
      }

      return reply.code(201).send({
        handle: target.handle,
        name: target.name,
        picture: target.picture,
        role: collabRole,
        projectRoles,
      });
    },
  );

  app.delete<{ Params: { handle: string; projectName: string; collaboratorHandle: string } }>(
    "/projects/:handle/:projectName/collaborators/:collaboratorHandle",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }
      if (project.access_role !== "Owner") {
        return forbiddenProblem(reply, "Only the owner can remove collaborators.");
      }

      const userResult = await query<{ id: string }>(
        "SELECT id FROM users WHERE lower(handle) = lower($1)",
        [req.params.collaboratorHandle],
      );
      if (userResult.rowCount === 0) {
        return writeProblem(reply, 404, "User not found", "User not found.");
      }

      const targetId = userResult.rows[0].id;
      await query(
        "DELETE FROM project_member_roles WHERE project_id = $1 AND user_id = $2",
        [project.project_id, targetId],
      );
      const result = await query(
        "DELETE FROM project_collaborators WHERE project_id = $1 AND user_id = $2",
        [project.project_id, targetId],
      );
      if (result.rowCount === 0) {
        return writeProblem(reply, 404, "Collaborator not found", "Not a collaborator.");
      }
      return reply.code(204).send();
    },
  );

  app.put<{
    Params: { handle: string; projectName: string; collaboratorHandle: string };
    Body: { projectRoles?: string[] };
  }>(
    "/projects/:handle/:projectName/collaborators/:collaboratorHandle/roles",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const project = await resolveProjectAccessByHandle(req.params.handle, req.params.projectName, user);
      if (!project) {
        return writeProblem(reply, 404, "Project not found", "Project not found or access denied.");
      }
      if (project.access_role !== "Owner") {
        return forbiddenProblem(reply, "Only the owner can manage project member roles.");
      }

      const projectRoles = req.body?.projectRoles;
      if (!projectRoles || !Array.isArray(projectRoles) || projectRoles.length === 0) {
        return writeProblem(reply, 400, "Invalid project roles", "At least one project role is required.");
      }

      const userResult = await query<{ id: string }>(
        "SELECT id FROM users WHERE lower(handle) = lower($1)",
        [req.params.collaboratorHandle],
      );
      if (userResult.rowCount === 0) {
        return writeProblem(reply, 404, "User not found", "User not found.");
      }
      const targetId = userResult.rows[0].id;

      const isOwner = targetId === project.owner_id;
      if (!isOwner) {
        const collabCheck = await query(
          "SELECT 1 FROM project_collaborators WHERE project_id = $1 AND user_id = $2",
          [project.project_id, targetId],
        );
        if (collabCheck.rowCount === 0) {
          return writeProblem(reply, 404, "Project member not found", "Not a project member.");
        }
      }

      const validRoles = await query<{ name: string }>(
        "SELECT name FROM project_roles WHERE project_id = $1",
        [project.project_id],
      );
      const validSet = new Set(validRoles.rows.map((row) => row.name));
      for (const roleName of projectRoles) {
        if (!validSet.has(roleName)) {
          return writeProblem(reply, 400, "Invalid project role", `Invalid project role: ${roleName}`);
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "DELETE FROM project_member_roles WHERE project_id = $1 AND user_id = $2",
          [project.project_id, targetId],
        );
        await client.query(
          `INSERT INTO project_member_roles (project_id, user_id, role_name)
           SELECT $1, $2, unnest($3::text[])`,
          [project.project_id, targetId, projectRoles],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      return { projectRoles };
    },
  );

  app.get("/integrations", async (req) => {
    const user = (req as V1AuthRequest).auth;
    const result = await query<{
      provider: string;
      status: string;
      refresh_token_enc: string | null;
      token_expires_at: Date | null;
    }>(
      `SELECT provider::text AS provider, status, refresh_token_enc, token_expires_at
       FROM user_integrations
       WHERE user_id = $1`,
      [user.id],
    );

    const statusByProvider = new Map(result.rows.map((row) => [row.provider, row]));

    return {
      items: ["notion", "google"].map((provider) => {
        const providerRow = statusByProvider.get(provider);
        if (!providerRow) {
          return { provider, status: "disconnected" as V1IntegrationStatus };
        }

        const hasRefresh = providerRow.refresh_token_enc !== null;
        const status = providerRow.status as V1IntegrationStatus;
        if (
          status === "connected"
          && providerRow.token_expires_at
          && providerRow.token_expires_at.getTime() <= Date.now()
        ) {
          return {
            provider,
            status: hasRefresh ? ("needs_reauth" as V1IntegrationStatus) : ("expired" as V1IntegrationStatus),
          };
        }

        return { provider, status };
      }),
    };
  });

  app.get<{ Querystring: { projectId?: string; page?: number; pageSize?: number } }>(
    "/threads",
    { config: { anonymousCache: true } },
    async (req) => {
      const viewerUserId = getOptionalAuthUser(req)?.id ?? null;
      const page = parsePositiveInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
      const pageSize = parsePositiveInt(req.query.pageSize, 50, 1, 200);
      const offset = (page - 1) * pageSize;

      const params: Array<unknown> = [viewerUserId];
      const limitParam = params.length + 1;
      const offsetParam = params.length + 2;
      params.push(pageSize + 1, offset);

      const projectFilterClause = req.query.projectId
        ? `AND p.id = $${params.push(req.query.projectId)}`
        : "";

      const result = await query<V1ThreadSummaryRow>(
        `SELECT
           t.id,
           t.project_thread_id,
           t.title,
           t.description,
           t.source_thread_id,
           p.name AS project_name,
           t.project_id,
           t.status,
           u.handle AS created_by_handle,
           owner_u.handle AS owner_handle,
           t.created_at,
           t.updated_at,
           COALESCE(NULLIF(pc.role::text, ''),
             CASE WHEN p.owner_id = $1 THEN 'Owner' ELSE 'Viewer' END
           )::text AS access_role
         FROM threads t
         JOIN projects p ON p.id = t.project_id
         JOIN users u ON u.id = t.created_by
         JOIN users owner_u ON owner_u.id = p.owner_id
         LEFT JOIN project_collaborators pc
           ON pc.project_id = p.id
          AND pc.user_id = $1
         WHERE p.is_archived = false
           AND (p.visibility = 'public' OR p.owner_id = $1 OR pc.user_id IS NOT NULL)
           ${projectFilterClause}
         ORDER BY t.updated_at DESC
         LIMIT $${limitParam}
         OFFSET $${offsetParam}`,
        params,
      );

      const hasMore = result.rows.length > pageSize;
      const rows = hasMore ? result.rows.slice(0, pageSize) : result.rows;

      return {
        items: rows.map((row) => ({
          id: row.id,
          projectThreadId: row.project_thread_id,
          projectId: row.project_id,
          sourceThreadId: row.source_thread_id,
          title: row.title,
          description: row.description,
          status: row.status,
          createdByHandle: row.created_by_handle,
          ownerHandle: row.owner_handle,
          projectName: row.project_name,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
          accessRole: row.access_role,
        })),
        page,
        pageSize,
        nextCursor: hasMore ? String(page + 1) : null,
      } as V1ListCursor & { items: unknown[] };
    },
  );

  app.post<{ Body: { projectId?: string; title?: string; description?: string; sourceThreadId?: string } }>(
    "/threads",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const projectId = req.body?.projectId?.trim();
      const title = req.body?.title?.trim();
      const sourceThreadId = req.body?.sourceThreadId?.trim();
      if (typeof sourceThreadId === "string" && !isUuid(sourceThreadId)) {
        return writeProblem(reply, 400, "Invalid sourceThreadId", "sourceThreadId must be a UUID.");
      }
      const sourceValidThreadId = sourceThreadId && isUuid(sourceThreadId) ? sourceThreadId : null;

      if (!projectId || !isUuid(projectId)) {
        return writeProblem(reply, 400, "Invalid projectId", "projectId must be a UUID.");
      }

      const project = await resolveProjectAccess(projectId, user);
      if (!project) {
        return writeProblem(reply, 403, "Project not found", "Project not found or access denied.");
      }

      if (!canEdit(project.access_role)) {
        return forbiddenProblem(reply);
      }

      const sourceThread = sourceValidThreadId
        ? await query<{ id: string }>(`SELECT id FROM threads WHERE id = $1 AND project_id = $2`, [sourceValidThreadId, projectId])
        : await query<{ id: string }>(
        "SELECT id FROM threads WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1",
        [projectId],
        );
      if (sourceThread.rowCount === 0) {
        return writeProblem(reply, 400, "No source thread", "No source thread exists for project.");
      }

      const threadId = randomUUID();
      const resolvedTitle = title && title.length > 0 ? title : `Thread ${Date.now()}`;
      await query<{ id: string }>(
        "SELECT clone_thread($1, $2, $3, $4, $5, $6)",
        [
          threadId,
          sourceThread.rows[0]!.id,
          projectId,
          user.id,
          resolvedTitle,
          req.body?.description?.trim() || null,
        ],
      );

      const inserted = await query<V1ThreadSummaryRow>(
        `SELECT
           t.id,
           t.project_thread_id,
           t.title,
           t.description,
           t.source_thread_id,
           p.name AS project_name,
           t.project_id,
           t.status,
           u.handle AS created_by_handle,
           owner_u.handle AS owner_handle,
           t.created_at,
           t.updated_at,
           'Owner'::text AS access_role
         FROM threads t
         JOIN projects p ON p.id = t.project_id
         JOIN users u ON u.id = t.created_by
         JOIN users owner_u ON owner_u.id = p.owner_id
         WHERE t.id = $1`,
        [threadId],
      );

      if (inserted.rowCount === 0) {
        return writeProblem(reply, 500, "Thread creation failed", "Failed to create thread.");
      }

      const created = inserted.rows[0];
      const responseProjectThreadId = created.project_thread_id;
      await publishEvent({
        type: "assistant.run.started",
        aggregateType: "thread",
        aggregateId: threadId,
        orgId: user.orgId,
        traceId: threadId,
        payload: {
          threadId,
          projectId,
          action: "create",
        },
      });

        return {
          id: created.id,
          projectThreadId: responseProjectThreadId,
          projectId: created.project_id,
          sourceThreadId: created.source_thread_id,
          title: created.title,
        description: created.description,
        status: created.status,
        createdByHandle: created.created_by_handle,
        ownerHandle: created.owner_handle,
        projectName: created.project_name,
        createdAt: created.created_at.toISOString(),
        updatedAt: created.updated_at.toISOString(),
        accessRole: created.access_role,
      };
    },
  );

  app.get<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring }>(
    "/threads/:threadId",
    { config: { anonymousCache: true } },
    async (req, reply) => {
      const viewerUserId = getOptionalAuthUser(req)?.id ?? null;
      const threadId = req.params.threadId;
      const threadAccess = await resolveThreadAccessByRequestParam(threadId, viewerUserId, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      const resolvedThreadId = thread.id;

      // thread_current_system() cannot change within a request, so it is resolved
      // once here and passed down. Three getThreadSystemId() calls and two inline
      // subqueries previously resolved the same value five times per read.
      const systemId = await getThreadSystemId(resolvedThreadId);

      const [projectRow, messagesResult, systemTopology, systemEdges, matrixCells, concernRows, matrixDocumentsRows] = await Promise.all([
        query<{ project_name: string; owner_handle: string; creator_handle: string }>(
          `SELECT p.name AS project_name, owner_u.handle AS owner_handle, u.handle AS creator_handle
           FROM threads t
           JOIN projects p ON p.id = t.project_id
           JOIN users owner_u ON owner_u.id = p.owner_id
           JOIN users u ON u.id = t.created_by
           WHERE t.id = $1`,
          [resolvedThreadId],
        ),
        query<{
          id: string;
          action_id: string;
          action_type: string;
          action_position: number;
          role: "User" | "Assistant" | "System";
          content: string;
          sender_model: string | null;
          created_at: Date;
        }>(
            `SELECT m.id, m.action_id, a.type::text AS action_type, a.position AS action_position,
                    m.role, m.content, m.created_at,
                    ar.model AS sender_model
               FROM messages m
               JOIN actions a ON a.thread_id = m.thread_id AND a.id = m.action_id
               LEFT JOIN LATERAL (
                 SELECT ar.model
                 FROM agent_runs ar
                 WHERE ar.thread_id = m.thread_id
                   AND ar.completed_at IS NOT NULL
                   AND ar.created_at <= m.created_at
                 ORDER BY ar.completed_at DESC, ar.created_at DESC
                 LIMIT 1
               ) ar ON a.type::text = 'ExecuteResponse'
              WHERE m.thread_id = $1
              ORDER BY a.position, m.created_at`,
          [resolvedThreadId],
        ),
        query<{ id: string; name: string; kind: string; parent_id: string | null; metadata: Record<string, unknown> }>(
         `SELECT n.id, n.name, n.kind::text AS kind, n.parent_id, n.metadata
            FROM nodes n
           WHERE n.system_id = $1
           ORDER BY n.id`,
          [systemId],
        ),
        query<{ id: string; from_node_id: string; to_node_id: string; type: string; metadata: Record<string, unknown> }>(
          `SELECT e.id, e.from_node_id, e.to_node_id, e.type::text AS type, e.metadata
           FROM edges e
           WHERE e.system_id = $1
           ORDER BY e.id`,
          [systemId],
        ),
        systemId ? loadThreadMatrix(systemId) : Promise.resolve([] as V1ThreadMatrixNodeCell[]),
        systemId
          ? query<V1ProjectThreadConcernRow>(
              `SELECT name, position FROM concerns WHERE system_id = $1 ORDER BY position`,
              [systemId],
            ).then((result) => result.rows)
          : Promise.resolve([] as V1ProjectThreadConcernRow[]),
        // `text` is deliberately not selected here: documents are the largest rows
        // in the schema and most are not open when a thread loads. Bodies are
        // fetched per hash from GET /threads/:threadId/matrix/documents/:hash.
        systemId
          ? query<V1ThreadDocumentMetadataRow>(
              `SELECT hash, kind::text AS kind, title, language, source_type::text AS source_type,
                      source_url, source_external_id, source_metadata, source_connected_user_id
               FROM documents
               WHERE system_id = $1
               ORDER BY created_at, hash`,
              [systemId],
            ).then((result) => result.rows)
          : Promise.resolve([] as V1ThreadDocumentMetadataRow[]),
      ]);

      const project = projectRow.rows[0];
      const topology = toTopology(systemTopology.rows, systemEdges.rows);

      return {
        thread: {
          id: thread.id,
          projectId: thread.project_id,
          title: thread.title,
          description: thread.description,
          status: thread.status,
          createdAt: thread.created_at.toISOString(),
          createdByHandle: project?.creator_handle ?? "unknown",
          ownerHandle: project?.owner_handle ?? "unknown",
          projectName: project?.project_name ?? "",
          accessRole: thread.access_role,
        },
        permissions: {
          canView: true,
          canEdit: canEdit(thread.access_role),
          canChat: canEdit(thread.access_role),
          canClose: canEdit(thread.access_role) && thread.status === "open",
          canCommit: canEdit(thread.access_role) && thread.status === "open",
        },
        topology,
        matrix: {
          nodes: topology.nodes,
          cells: matrixCells,
          concerns: concernRows.map((concern) => ({ name: concern.name, position: concern.position })),
          documents: matrixDocumentsRows.map((document) => ({
            hash: document.hash,
            kind: document.kind,
            title: document.title,
            language: document.language,
            sourceType: document.source_type,
            sourceUrl: document.source_url,
            sourceExternalId: document.source_external_id,
            sourceMetadata: document.source_metadata,
            sourceConnectedUserId: document.source_connected_user_id,
          })),
        },
        systemPrompt: null,
        systemPromptTitle: null,
        systemPrompts: [],
        chat: {
          messages: messagesResult.rows.map((message) => ({
            id: message.id,
            actionId: message.action_id,
            role: message.role,
            actionType: message.action_type,
            actionPosition: message.action_position,
            content: message.content,
            senderName: message.sender_model ? formatAssistantModelLabel(message.sender_model) : undefined,
            createdAt: message.created_at.toISOString(),
          })),
        },
      };
    },
  );

  app.patch<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring; Body: V1ThreadPatchBody }>(
    "/threads/:threadId",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadId = req.params.threadId;
      const threadAccess = await resolveThreadAccessByRequestParam(threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      const resolvedThreadId = thread.id;

      if (!canEdit(thread.access_role)) {
        return forbiddenProblem(reply);
      }

      const updates: string[] = [];
      const params: Array<unknown> = [];
      if (typeof req.body?.title !== "undefined") {
        const nextTitle = req.body.title?.trim();
        if (!nextTitle) return writeProblem(reply, 400, "Invalid title", "title cannot be empty");
        updates.push(`title = $${updates.length + 1}`);
        params.push(nextTitle);
      }

      if (typeof req.body?.description !== "undefined") {
        const nextDescription = req.body.description === null ? null : req.body.description.trim();
        updates.push(`description = $${updates.length + 1}`);
        params.push(nextDescription);
      }

      if (typeof req.body?.status !== "undefined") {
        if (req.body.status !== "open" && req.body.status !== "closed" && req.body.status !== "committed") {
          return writeProblem(reply, 400, "Invalid status", "status must be open, closed, or committed");
        }
        updates.push(`status = $${updates.length + 1}`);
        params.push(req.body.status);
      }

      if (updates.length === 0) {
        return writeProblem(reply, 400, "No changes", "No updatable fields supplied.");
      }

      const result = await query<{ id: string; title: string; description: string | null; status: string }>(
        `UPDATE threads
            SET ${updates.join(", ")}
          WHERE id = $${updates.length + 1}
          RETURNING id, title, description, status`,
        [...params, resolvedThreadId],
      );

      if (result.rowCount === 0) {
        return writeProblem(reply, 404, "Thread not found", "Thread not found");
      }

      const updated = result.rows[0];
      return {
        thread: {
          id: updated.id,
          title: updated.title,
          description: updated.description,
          status: updated.status,
        },
      };
    },
  );

  app.delete<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring }>(
    "/threads/:threadId",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadId = req.params.threadId;
      const threadAccess = await resolveThreadAccessByRequestParam(threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      const resolvedThreadId = thread.id;

      if (!canEdit(thread.access_role)) {
        return forbiddenProblem(reply);
      }

      await query("DELETE FROM threads WHERE id = $1", [resolvedThreadId]);
      reply.code(204).send();
    },
  );

  app.get<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring }>(
    "/threads/:threadId/matrix",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadId = req.params.threadId;
      const threadAccess = await resolveThreadAccessByRequestParam(threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      const resolvedThreadId = thread.id;

      const systemId = await getThreadSystemId(resolvedThreadId);
      if (!systemId) {
        return writeProblem(reply, 500, "System missing", "Thread has no current system");
      }

      const [nodeResult, edgeResult, cells, concernRows, documentRows] = await Promise.all([
        query<{ id: string; name: string; kind: string; parent_id: string | null; metadata: Record<string, unknown> }>(
          `SELECT id, name, kind::text AS kind, parent_id, metadata
           FROM nodes
           WHERE system_id = $1 ORDER BY id`,
          [systemId],
        ),
        query<{ id: string; from_node_id: string; to_node_id: string; type: string; metadata: Record<string, unknown> }>(
          `SELECT id, from_node_id, to_node_id, type::text AS type, metadata
           FROM edges
           WHERE system_id = $1 ORDER BY id`,
          [systemId],
        ),
        loadThreadMatrix(systemId),
        query<V1ProjectThreadConcernRow>(
          `SELECT name, position FROM concerns WHERE system_id = $1 ORDER BY position`,
          [systemId],
        ).then((result) => result.rows),
        query<V1ProjectThreadDocumentRow>(
          `SELECT hash, kind::text AS kind, title, language, text, source_type::text AS source_type,
                  source_url, source_external_id, source_metadata, source_connected_user_id
           FROM documents
           WHERE system_id = $1
           ORDER BY created_at, hash`,
          [systemId],
        ).then((result) => result.rows),
      ]);

      return {
        threadId: resolvedThreadId,
        systemId,
        topology: toTopology(nodeResult.rows, edgeResult.rows),
        matrix: {
          nodes: toTopology(nodeResult.rows, edgeResult.rows).nodes,
          cells,
          concerns: concernRows.map((concern) => ({ name: concern.name, position: concern.position })),
          documents: documentRows.map((document) => ({
            hash: document.hash,
            kind: document.kind,
            title: document.title,
            language: document.language,
            text: document.text,
            sourceType: document.source_type,
            sourceUrl: document.source_url,
            sourceExternalId: document.source_external_id,
            sourceMetadata: document.source_metadata,
            sourceConnectedUserId: document.source_connected_user_id,
          })),
        },
      };
    },
  );

  // GET /threads/:threadId returns document metadata without `text`. These two
  // routes serve the bodies: one document at a time when the UI opens it, and a
  // hash list when the document picker runs a full-text search. Documents are
  // content-addressed, so a body fetched by hash is immutable and caches forever.
  app.get<{ Params: { threadId: string; hash: string }; Querystring: V1ThreadScopeQuerystring }>(
    "/threads/:threadId/matrix/documents/:hash",
    { config: { anonymousCache: true } },
    async (req, reply) => {
      const viewerUserId = getOptionalAuthUser(req)?.id ?? null;
      const threadAccess = await resolveThreadAccessByRequestParam(req.params.threadId, viewerUserId, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }

      const systemId = await getThreadSystemId(threadAccess.thread.id);
      if (!systemId) return notFoundProblem(reply, "Document not found");

      const result = await query<V1ProjectThreadDocumentRow>(
        `SELECT hash, kind::text AS kind, title, language, text, source_type::text AS source_type,
                source_url, source_external_id, source_metadata, source_connected_user_id
         FROM documents
         WHERE system_id = $1 AND hash = $2`,
        [systemId, req.params.hash],
      );

      const document = result.rows[0];
      if (!document) return notFoundProblem(reply, "Document not found");

      return {
        document: {
          hash: document.hash,
          kind: document.kind,
          title: document.title,
          language: document.language,
          text: document.text,
          sourceType: document.source_type,
          sourceUrl: document.source_url,
          sourceExternalId: document.source_external_id,
          sourceMetadata: document.source_metadata,
          sourceConnectedUserId: document.source_connected_user_id,
        },
      };
    },
  );

  app.get<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring & { q?: string } }>(
    "/threads/:threadId/matrix/documents",
    { config: { anonymousCache: true } },
    async (req, reply) => {
      const viewerUserId = getOptionalAuthUser(req)?.id ?? null;
      const threadAccess = await resolveThreadAccessByRequestParam(req.params.threadId, viewerUserId, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }

      const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!search) return { hashes: [] };

      const systemId = await getThreadSystemId(threadAccess.thread.id);
      if (!systemId) return { hashes: [] };

      const result = await query<{ hash: string }>(
        `SELECT hash FROM documents
          WHERE system_id = $1 AND text ILIKE $2 ESCAPE '${SQL_LIKE_ESCAPE_CHARACTER}'
          ORDER BY created_at, hash
          LIMIT 200`,
        [systemId, toLikeContainsPattern(search)],
      );

      return { hashes: result.rows.map((row) => row.hash) };
    },
  );

  // Attach a document to one or more matrix cells.
  app.post<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring; Body: unknown }>(
    "/threads/:threadId/matrix/refs",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadAccess = await resolveThreadAccessByRequestParam(req.params.threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      if (!canEdit(thread.access_role)) return forbiddenProblem(reply);

      let payload = normalizeMatrixRefBody(req.body);
      if (!payload) {
        return writeProblem(reply, 400, "Invalid matrix reference", "nodeId, docHash, refType and at least one concern are required.");
      }

      const client = await pool.connect();
      let inTransaction = false;
      let actionMessages: V1ChatMessage[] = [];

      try {
        await client.query("BEGIN");
        inTransaction = true;

        const actionId = randomUUID();
        const outputSystemId = await beginMatrixAction(client, thread.id, actionId, "Edit", "Matrix doc add");

        if (payload.refType === "Prompt") {
          const validation = await validateSystemPromptAttachment(client, outputSystemId, payload);
          if (!validation.valid) {
            await rollbackQuietly(client);
            inTransaction = false;
            return writeProblem(reply, 400, "Invalid system prompt", validation.error);
          }
          payload = validation.payload;
        }

        let changed = 0;
        for (const concern of payload.concerns) {
          const inserted = await client.query(
            `INSERT INTO matrix_refs (system_id, node_id, concern, ref_type, doc_hash)
             VALUES ($1, $2, $3, $4::ref_type, $5)
             ON CONFLICT DO NOTHING`,
            [outputSystemId, payload.nodeId, concern, payload.refType, payload.docHash],
          );
          changed += inserted.rowCount ?? 0;
        }

        if (changed === 0) {
          await client.query("SELECT commit_action_empty($1, $2)", [thread.id, actionId]);
        } else {
          const title = await getDocumentTitleByHash(client, outputSystemId, payload.docHash) ?? payload.docHash;
          const nodeName = await getNodeNameById(client, outputSystemId, payload.nodeId);
          await insertSystemActionMessage(client, thread.id, actionId, buildDocumentAddSummary(title, nodeName));
          actionMessages = await getActionMessages(client, thread.id, actionId);
        }

        await client.query("COMMIT");
        inTransaction = false;
      } catch (error: unknown) {
        if (inTransaction) await rollbackQuietly(client);
        if (isForeignKeyViolation(error)) {
          return writeProblem(reply, 400, "Invalid matrix reference", "Unknown node, concern, or document.");
        }
        throw error;
      } finally {
        client.release();
      }

      const systemId = await getThreadSystemId(thread.id);
      if (!systemId) return writeProblem(reply, 500, "System missing", "Thread has no current system");

      await publishThreadMatrixChanged(thread.id, user, thread.id);
      return buildMatrixRefResponse(
        systemId,
        await getMatrixCellsForNode(systemId, payload.nodeId, payload.concerns),
        actionMessages,
        payload.refType === "Prompt" ? await getSystemPromptMetadata(systemId) : undefined,
      );
    },
  );

  // Detach a document from one or more matrix cells.
  app.delete<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring; Body: unknown }>(
    "/threads/:threadId/matrix/refs",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadAccess = await resolveThreadAccessByRequestParam(req.params.threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      if (!canEdit(thread.access_role)) return forbiddenProblem(reply);

      let payload = normalizeMatrixRefBody(req.body);
      if (!payload) {
        return writeProblem(reply, 400, "Invalid matrix reference", "nodeId, docHash, refType and at least one concern are required.");
      }

      const client = await pool.connect();
      let inTransaction = false;
      let actionMessages: V1ChatMessage[] = [];

      try {
        await client.query("BEGIN");
        inTransaction = true;

        const actionId = randomUUID();
        const outputSystemId = await beginMatrixAction(client, thread.id, actionId, "Edit", "Matrix doc remove");

        if (payload.refType === "Prompt") {
          const validation = await validateSystemPromptAttachment(client, outputSystemId, payload);
          if (!validation.valid) {
            await rollbackQuietly(client);
            inTransaction = false;
            return writeProblem(reply, 400, "Invalid system prompt", validation.error);
          }
          payload = validation.payload;
        }

        // The title has to be read before the ref goes, or the summary message
        // would have nothing left to name.
        const title = await getDocumentTitleByHash(client, outputSystemId, payload.docHash) ?? payload.docHash;
        const nodeName = await getNodeNameById(client, outputSystemId, payload.nodeId);

        let changed = 0;
        for (const concern of payload.concerns) {
          const deleted = await client.query(
            `DELETE FROM matrix_refs
              WHERE system_id = $1
                AND node_id = $2
                AND concern_hash = md5($3)
                AND concern = $3
                AND ref_type = $4::ref_type
                AND doc_hash = $5`,
            [outputSystemId, payload.nodeId, concern, payload.refType, payload.docHash],
          );
          changed += deleted.rowCount ?? 0;
        }

        if (changed === 0) {
          await client.query("SELECT commit_action_empty($1, $2)", [thread.id, actionId]);
        } else {
          await insertSystemActionMessage(client, thread.id, actionId, buildDocumentRemoveSummary(title, nodeName));
          actionMessages = await getActionMessages(client, thread.id, actionId);
        }

        await client.query("COMMIT");
        inTransaction = false;
      } catch (error: unknown) {
        if (inTransaction) await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }

      const systemId = await getThreadSystemId(thread.id);
      if (!systemId) return writeProblem(reply, 500, "System missing", "Thread has no current system");

      await publishThreadMatrixChanged(thread.id, user, thread.id);
      return buildMatrixRefResponse(
        systemId,
        await getMatrixCellsForNode(systemId, payload.nodeId, payload.concerns),
        actionMessages,
        payload.refType === "Prompt" ? await getSystemPromptMetadata(systemId) : undefined,
      );
    },
  );

  // Create a document -- authored locally, or imported from a connected
  // provider -- and optionally attach it to a cell in the same action.
  app.post<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring; Body: unknown }>(
    "/threads/:threadId/matrix/documents",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadAccess = await resolveThreadAccessByRequestParam(req.params.threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      if (!canEdit(thread.access_role)) return forbiddenProblem(reply);

      const payload = normalizeMatrixDocumentCreateBody(req.body);
      if (!payload) {
        return writeProblem(reply, 400, "Invalid document", "A local document needs kind, title, name and description; an imported one needs kind and sourceUrl.");
      }
      if (payload.kind === "Prompt" && payload.sourceType !== "local") {
        return writeProblem(reply, 400, "Invalid system prompt", "System prompts must be local documents.");
      }
      if (payload.kind === "Prompt" && !payload.attach) {
        return writeProblem(reply, 400, "Invalid system prompt", "System prompts require an attach payload.");
      }

      let sourceUrl: string | null = null;
      let sourceExternalId: string | null = null;
      let sourceMetadata: Record<string, unknown> | null = null;
      let sourceConnectedUserId: string | null = null;
      let title = payload.title ?? "";
      let text: string;

      if (payload.sourceType === "local") {
        text = buildDocumentText({
          name: payload.name ?? "",
          description: payload.description ?? "",
          body: payload.body ?? "",
        });
      } else {
        try {
          const remote = await fetchRemoteDocument(user.id, payload.sourceType, payload.sourceUrl ?? "");
          sourceUrl = remote.sourceUrl;
          sourceExternalId = remote.sourceExternalId;
          sourceMetadata = remote.sourceMetadata;
          sourceConnectedUserId = user.id;
          title = remote.title || title || "Imported document";
          text = remote.text;
        } catch (error: unknown) {
          if (isIntegrationReconnectError(error)) {
            req.log.warn({ threadId: thread.id, provider: error.provider, status: error.status }, "Document import blocked by integration state");
            return writeProblem(
              reply,
              409,
              "Integration required",
              `Reconnect ${error.provider} to import this document.`,
              "integration_reconnect_required",
            );
          }
          if (isNotionApiError(error)) {
            req.log.warn({ threadId: thread.id, status: error.status, reason: error.reason }, "Notion document import failed");
            return writeProblem(reply, error.status >= 500 ? 502 : 400, "Import failed", error.reason, "notion_import_failed");
          }
          req.log.error({ threadId: thread.id, sourceType: payload.sourceType, err: error }, "Document import failed");
          throw error;
        }
      }

      const hash = computeDocumentHash({ kind: payload.kind, title, language: payload.language, body: text });

      const client = await pool.connect();
      let inTransaction = false;
      let actionMessages: V1ChatMessage[] = [];
      let attach = payload.attach;
      let insertedDocument: V1MatrixDocumentRow | null = null;

      try {
        await client.query("BEGIN");
        inTransaction = true;

        const actionId = randomUUID();
        const isImport = payload.sourceType !== "local";
        const outputSystemId = await beginMatrixAction(
          client,
          thread.id,
          actionId,
          isImport ? "Import" : "Edit",
          isImport ? "Matrix doc import" : "Matrix doc create",
        );

        if (payload.kind === "Prompt" && attach) {
          const validation = await validateSystemPromptAttachment(client, outputSystemId, {
            nodeId: attach.nodeId,
            concerns: attach.concerns,
            docHash: attach.docHash ?? hash,
          });
          if (!validation.valid) {
            await rollbackQuietly(client);
            inTransaction = false;
            return writeProblem(reply, 400, "Invalid system prompt", validation.error);
          }
          attach = { ...validation.payload, docHash: hash };
        }

        const insertResult = await client.query<V1MatrixDocumentRow>(
          `INSERT INTO documents (
             hash, system_id, kind, title, language, text, source_type,
             source_url, source_external_id, source_metadata, source_connected_user_id
           )
           VALUES ($1, $2, $3::doc_kind, $4, $5, $6, $7::doc_source_type, $8, $9, $10, $11)
           ON CONFLICT (system_id, hash) DO NOTHING
           RETURNING ${MATRIX_DOCUMENT_COLUMNS}`,
          [
            hash, outputSystemId, payload.kind, title, payload.language, text,
            payload.sourceType, sourceUrl, sourceExternalId, sourceMetadata, sourceConnectedUserId,
          ],
        );
        insertedDocument = insertResult.rows[0] ?? null;

        let attachedRefs = 0;
        if (attach) {
          for (const concern of attach.concerns) {
            const inserted = await client.query(
              `INSERT INTO matrix_refs (system_id, node_id, concern, ref_type, doc_hash)
               VALUES ($1, $2, $3, $4::ref_type, $5)
               ON CONFLICT DO NOTHING`,
              [outputSystemId, attach.nodeId, concern, attach.refType, hash],
            );
            attachedRefs += inserted.rowCount ?? 0;
          }
        }

        // Re-creating an identical document that is already attached changes
        // nothing, and the forked system is dropped rather than kept empty.
        if ((insertResult.rowCount ?? 0) === 0 && attachedRefs === 0) {
          await client.query("SELECT commit_action_empty($1, $2)", [thread.id, actionId]);
        } else {
          const nodeName = attach ? await getNodeNameById(client, outputSystemId, attach.nodeId) : null;
          await insertSystemActionMessage(
            client,
            thread.id,
            actionId,
            buildDocumentCreateSummary(title, payload.sourceType, nodeName, attachedRefs > 0),
          );
          actionMessages = await getActionMessages(client, thread.id, actionId);
        }

        await client.query("COMMIT");
        inTransaction = false;
      } catch (error: unknown) {
        if (inTransaction) await rollbackQuietly(client);
        if (isForeignKeyViolation(error)) {
          return writeProblem(reply, 400, "Invalid attachment", "Unknown node or concern.");
        }
        throw error;
      } finally {
        client.release();
      }

      const systemId = await getThreadSystemId(thread.id);
      if (!systemId) return writeProblem(reply, 500, "System missing", "Thread has no current system");

      await publishThreadMatrixChanged(thread.id, user, thread.id);
      const document = insertedDocument
        ? toV1MatrixDocument(insertedDocument)
        : {
            hash,
            kind: payload.kind as string,
            title,
            language: payload.language,
            text,
            sourceType: payload.sourceType as string,
            sourceUrl,
            sourceExternalId,
            sourceMetadata,
            sourceConnectedUserId,
          };
      const cells = attach ? await getMatrixCellsForNode(systemId, attach.nodeId, attach.concerns) : [];

      return {
        systemId,
        document,
        ...(cells.length === 1 ? { cell: cells[0] } : {}),
        ...(cells.length > 0 ? { cells } : {}),
        messages: actionMessages,
        ...(payload.kind === "Prompt" ? await getSystemPromptMetadata(systemId) : {}),
      };
    },
  );

  // Edit a document. Documents are content-addressed, so an edit inserts a new
  // row under a new hash and repoints every ref at it; the old row stays, which
  // is what makes an earlier action's view of the document still resolvable.
  app.patch<{ Params: { threadId: string; hash: string }; Querystring: V1ThreadScopeQuerystring; Body: unknown }>(
    "/threads/:threadId/matrix/documents/:hash",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadAccess = await resolveThreadAccessByRequestParam(req.params.threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      if (!canEdit(thread.access_role)) return forbiddenProblem(reply);

      const documentHash = req.params.hash.trim();
      const payload = normalizeMatrixDocumentReplaceBody(req.body);
      if (!documentHash || !payload) {
        return writeProblem(reply, 400, "Invalid document patch", "Supply at least one of title, name, description, language or body.");
      }

      const client = await pool.connect();
      let inTransaction = false;
      let actionMessages: V1ChatMessage[] = [];

      try {
        await client.query("BEGIN");
        inTransaction = true;

        const actionId = randomUUID();
        const outputSystemId = await beginMatrixAction(client, thread.id, actionId, "Edit", "Matrix doc replace");

        const existingResult = await client.query<V1MatrixDocumentRow>(
          `SELECT ${MATRIX_DOCUMENT_COLUMNS} FROM documents WHERE system_id = $1 AND hash = $2`,
          [outputSystemId, documentHash],
        );
        const existing = existingResult.rows[0];
        if (!existing) {
          await rollbackQuietly(client);
          inTransaction = false;
          return notFoundProblem(reply, "Document not found");
        }

        const isPromptDocument = existing.kind === "Prompt";
        const isRemoteDocument = existing.source_type !== "local";

        if (isPromptDocument && isRemoteDocument) {
          await rollbackQuietly(client);
          inTransaction = false;
          return writeProblem(reply, 400, "Invalid system prompt", "Prompt documents must be local.");
        }

        if (isPromptDocument) {
          const rootNodeId = await getSystemRootNodeId(outputSystemId, client);
          if (!rootNodeId) {
            await rollbackQuietly(client);
            inTransaction = false;
            return writeProblem(reply, 500, "System missing", "Unable to resolve system root node");
          }
          const strayRefs = await client.query(
            `SELECT 1 FROM matrix_refs
              WHERE system_id = $1 AND doc_hash = $2
                AND ref_type = 'Prompt'::ref_type AND node_id <> $3
              LIMIT 1`,
            [outputSystemId, documentHash, rootNodeId],
          );
          if ((strayRefs.rowCount ?? 0) > 0) {
            await rollbackQuietly(client);
            inTransaction = false;
            return writeProblem(reply, 400, "Invalid system prompt", "Prompt documents must remain attached to the system root node.");
          }
        }

        // A remote document's text is a snapshot of what the provider returned.
        // Editing it here would make the local copy disagree with its source
        // while still claiming to be that source; refreshing it is a re-import.
        if (isRemoteDocument && (payload.body !== undefined || payload.name !== undefined || payload.description !== undefined)) {
          await rollbackQuietly(client);
          inTransaction = false;
          return writeProblem(
            reply,
            400,
            "Imported document is read-only",
            "Imported documents cannot be edited as markdown. Re-import to refresh the snapshot.",
          );
        }

        const nextTitle = payload.title ?? existing.title;
        const nextLanguage = payload.language ?? existing.language;
        const parsedExisting = isRemoteDocument ? null : parseDocumentText(existing.text);
        const existingName = parsedExisting?.name && isValidDocumentName(parsedExisting.name)
          ? parsedExisting.name
          : deriveDocumentName(nextTitle);
        const nextText = isRemoteDocument
          ? existing.text
          : buildDocumentText({
              name: payload.name ?? existingName,
              description: payload.description ?? parsedExisting?.description ?? "",
              body: payload.body ?? parsedExisting?.body ?? "",
            });
        const nextHash = computeDocumentHash({
          kind: existing.kind as DocKind,
          title: nextTitle,
          language: nextLanguage,
          body: nextText,
        });

        const insertResult = await client.query<V1MatrixDocumentRow>(
          `INSERT INTO documents (
             hash, system_id, kind, title, language, text, source_type,
             source_url, source_external_id, source_metadata, source_connected_user_id, supersedes
           )
           VALUES ($1, $2, $3::doc_kind, $4, $5, $6, $7::doc_source_type, $8, $9, $10, $11, $12)
           ON CONFLICT (system_id, hash) DO NOTHING
           RETURNING ${MATRIX_DOCUMENT_COLUMNS}`,
          [
            nextHash, outputSystemId, existing.kind, nextTitle, nextLanguage, nextText,
            existing.source_type, existing.source_url, existing.source_external_id,
            existing.source_metadata, existing.source_connected_user_id, existing.hash,
          ],
        );

        const updatedRefs = await client.query(
          `UPDATE matrix_refs SET doc_hash = $3 WHERE system_id = $1 AND doc_hash = $2`,
          [outputSystemId, existing.hash, nextHash],
        );
        const replacedRefs = updatedRefs.rowCount ?? 0;

        if ((insertResult.rowCount ?? 0) === 0 && replacedRefs === 0) {
          await client.query("SELECT commit_action_empty($1, $2)", [thread.id, actionId]);
        } else {
          const nodeNames = await getNodeNamesByDocumentHash(client, outputSystemId, nextHash);
          await insertSystemActionMessage(
            client,
            thread.id,
            actionId,
            buildDocumentModifySummary(existing.title, nextTitle, nodeNames),
          );
          actionMessages = await getActionMessages(client, thread.id, actionId);
        }

        await client.query("COMMIT");
        inTransaction = false;

        const systemId = await getThreadSystemId(thread.id);
        if (!systemId) return writeProblem(reply, 500, "System missing", "Thread has no current system");

        await publishThreadMatrixChanged(thread.id, user, thread.id);
        return {
          systemId,
          oldHash: existing.hash,
          document: insertResult.rows[0]
            ? toV1MatrixDocument(insertResult.rows[0])
            : {
                hash: nextHash,
                kind: existing.kind,
                title: nextTitle,
                language: nextLanguage,
                text: nextText,
                sourceType: existing.source_type,
                sourceUrl: existing.source_url,
                sourceExternalId: existing.source_external_id,
                sourceMetadata: existing.source_metadata,
                sourceConnectedUserId: existing.source_connected_user_id,
              },
          replacedRefs,
          messages: actionMessages,
          ...(isPromptDocument ? await getSystemPromptMetadata(systemId) : {}),
        };
      } catch (error: unknown) {
        if (inTransaction) await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.patch<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring; Body: V1MatrixPatchBody }>(
    "/threads/:threadId/matrix",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadId = req.params.threadId;
      const threadAccess = await resolveThreadAccessByRequestParam(threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      const resolvedThreadId = thread.id;

      if (!canEdit(thread.access_role)) {
        return forbiddenProblem(reply);
      }

      const layout = normalizeToplologyPositions(req.body ?? {});
      if (layout.length === 0) {
        return writeProblem(reply, 400, "Invalid matrix payload", "No valid node layout entries provided.");
      }

      const systemId = await getThreadSystemId(resolvedThreadId);
      if (!systemId) {
        return writeProblem(reply, 500, "System missing", "Thread has no current system");
      }

      let changed = 0;
      for (const next of layout) {
        const result = await query<{ changed: number }>(
          `UPDATE nodes
              SET metadata = jsonb_set(
                coalesce(metadata, '{}'::jsonb),
                '{layout}',
                jsonb_build_object('x', $3::double precision, 'y', $4::double precision),
                true
              )
            WHERE system_id = $1 AND id = $2`,
          [systemId, next.nodeId, next.x, next.y],
        );
        changed += result.rowCount ?? 0;
      }

      if (changed === 0) {
        return notFoundProblem(reply, "No nodes updated");
      }

      await publishThreadMatrixChanged(resolvedThreadId, user, resolvedThreadId);
      const cells = await loadThreadMatrix(systemId);
      const topologyRows = await query<{ id: string; name: string; kind: string; parent_id: string | null; metadata: Record<string, unknown> }>(
        `SELECT id, name, kind::text AS kind, parent_id, metadata
           FROM nodes
          WHERE system_id = $1 ORDER BY id`,
        [systemId],
      );
      const topology = toTopology(topologyRows.rows, []);
      return {
        threadId: resolvedThreadId,
        systemId,
        changed,
        matrix: {
          nodes: topology.nodes,
          cells,
        },
      };
    },
  );

  app.get<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring }>(
    "/threads/:threadId/openship/bundle",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadId = req.params.threadId;
      const threadAccess = await resolveThreadAccessByRequestParam(threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      const resolvedThreadId = thread.id;

      if (!canEdit(thread.access_role)) {
        return forbiddenProblem(reply);
      }

      const systemId = await getThreadSystemId(resolvedThreadId);
      if (!systemId) {
        return writeProblem(reply, 500, "System missing", "Thread has no current system");
      }

      const workspace = await mkdtemp(join(tmpdir(), "acx-openship-bundle-"));
      try {
        const bundleDir = await generateOpenShipFileBundle(resolvedThreadId, workspace);
        const files = await collectOpenShipBundleFiles(bundleDir);
        const descriptor: V1OpenShipBundleDescriptor = {
          threadId: resolvedThreadId,
          systemId,
          generatedAt: new Date().toISOString(),
          files,
        };
        return descriptor;
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  app.post<{ Params: { threadId: string }; Querystring: V1ThreadScopeQuerystring; Body: V1ChatMessageRequest }>(
    "/threads/:threadId/chat",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadId = req.params.threadId;
      const threadAccess = await resolveThreadAccessByRequestParam(threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;
      const resolvedThreadId = thread.id;

      if (!canEdit(thread.access_role)) {
        return forbiddenProblem(reply);
      }

      const content = req.body?.content?.trim();
      if (!content) {
        return writeProblem(reply, 400, "Invalid message", "content is required");
      }

      const role = req.body?.role ?? "User";
      if (role !== "User" && role !== "Assistant" && role !== "System") {
        return writeProblem(reply, 400, "Invalid role", "role must be User, Assistant, or System");
      }

      const actionId = randomUUID();
      const messageId = randomUUID();
      const positionResult = await query<{ position: number }>(
        `SELECT COALESCE(MAX(position), 0) + 1 AS position
         FROM actions
         WHERE thread_id = $1`,
        [resolvedThreadId],
      );
      const actionPosition = positionResult.rows[0]?.position ?? 1;

      await query<{ id: string }>(
        `INSERT INTO actions (id, thread_id, position, type, title)
         VALUES ($1, $2, $3, 'Chat'::action_type, 'Chat message')`,
        [actionId, resolvedThreadId, actionPosition],
      );

      const messageResult = await query<{
        id: string;
        action_id: string;
        role: "User" | "Assistant" | "System";
        content: string;
        created_at: Date;
      }>(
        `INSERT INTO messages (id, thread_id, action_id, role, content, position)
         VALUES ($1, $2, $3, $4::message_role, $5, 1)
         RETURNING id, action_id, role, content, created_at`,
        [messageId, resolvedThreadId, actionId, role, content],
      );

      if (messageResult.rowCount === 0) {
        return writeProblem(reply, 500, "Failed to append message", "Failed to append message.");
      }

      const inserted = messageResult.rows[0];
      return {
        messages: [{
          id: inserted.id,
          actionId: inserted.action_id,
          role: inserted.role,
          actionType: "Chat",
          actionPosition,
          content: inserted.content,
          createdAt: inserted.created_at.toISOString(),
        }],
      };
    },
  );

  app.post<{
    Params: { threadId: string; assistantType: AssistantMode };
    Querystring: V1ThreadScopeQuerystring;
    Body: V1RunStartBody;
  }>(
    "/threads/:threadId/assistants/:assistantType/runs",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const threadId = req.params.threadId;
      const mode = req.params.assistantType;
      const chatMessageId = req.body?.chatMessageId?.trim() || null;
      const prompt = req.body?.prompt?.trim();
      const rawModel = req.body?.model;
      let resolvedModel: AssistantModel;
      if (rawModel === undefined) {
        resolvedModel = DEFAULT_ASSISTANT_MODEL;
      } else {
        const model = resolveAssistantModel(rawModel);
        if (model === null) {
          return writeProblem(
            reply,
            400,
            "Invalid model",
            "model must be one of claude-opus-4-6, claude-opus-4-7, claude-sonnet-4-6, codex-5.3, gpt-5.3-codex, gpt-5.5, or gpt-5.4",
          );
        }
        resolvedModel = normalizeAssistantModel(model);
      }


      const threadAccess = await resolveThreadAccessByRequestParam(threadId, user.id, req.query);
      if (threadAccess.kind !== "found") {
        writeThreadAccessFailure(reply, threadAccess);
        return;
      }
      const thread = threadAccess.thread;

      if (!canEdit(thread.access_role)) {
        return forbiddenProblem(reply);
      }

      if (mode !== "direct" && mode !== "plan") {
        return writeProblem(reply, 400, "Invalid assistant type", "assistantType must be direct or plan");
      }
      const resolvedThreadId = thread.id;

      if (chatMessageId && !isUuid(chatMessageId)) {
        return writeProblem(reply, 400, "Invalid chatMessageId", "chatMessageId must be a UUID.");
      }
      const resolvedPrompt = await resolveRunPrompt(resolvedThreadId, chatMessageId, prompt);
      const systemPrompt = await resolveSystemPrompt(resolvedThreadId);

      req.log.info(
        {
          threadId: resolvedThreadId,
          prompt: resolvedPrompt,
          systemPrompt,
        },
        "Passing control to agent with system prompt",
      );

      const runId = await enqueueAgentRunWithWait({
        threadId: resolvedThreadId,
        projectId: thread.project_id,
        requestedByUserId: user.id,
        mode,
        planActionId: null,
        chatMessageId,
        prompt: resolvedPrompt,
        model: resolvedModel,
        systemPrompt,
      });

      await publishEvent({
        type: "assistant.run.started",
        aggregateType: "assistant-run",
        aggregateId: runId,
        orgId: user.orgId,
        traceId: resolvedThreadId,
        payload: {
          threadId: resolvedThreadId,
          mode,
          status: "queued",
        },
      });
      await publishEvent({
        type: "assistant.run.waiting_input",
        aggregateType: "assistant-run",
        aggregateId: runId,
        orgId: user.orgId,
        traceId: resolvedThreadId,
        payload: {
          threadId: resolvedThreadId,
          mode,
          status: "waiting_input",
        },
      });

      return {
        runId,
        status: "queued" as AssistantRunStatus,
        mode,
        threadId: resolvedThreadId,
      };
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/assistant-runs/:runId",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const runId = req.params.runId;
      if (!isUuid(runId)) {
        return writeProblem(reply, 400, "Invalid run id", "runId must be a UUID.");
      }
      const run = await getAgentRunById(runId);
      if (!run) {
        return notFoundProblem(reply, "Run not found");
      }

      const thread = await resolveThreadAccess(run.thread_id, user.id);
      if (!thread) {
        return forbiddenProblem(reply);
      }

      return mapAssistantRunRow(run);
    },
  );

  app.post<{ Params: { runId: string }; Body: V1RunClaimBody }>(
    "/assistant-runs/:runId/claim",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const runId = req.params.runId;
      if (!isUuid(runId)) {
        return writeProblem(reply, 400, "Invalid run id", "runId must be a UUID.");
      }
      const run = await getAgentRunById(runId);
      if (!run) {
        return notFoundProblem(reply, "Run not found");
      }

      const thread = await resolveThreadAccess(run.thread_id, user.id);
      if (!thread) {
        return forbiddenProblem(reply, "Access denied for this run.");
      }

      const runnerId = req.body?.runnerId?.trim() || `desktop-${randomUUID()}`;
      const runSpec = await query<{ spec_version: string }>(
        `SELECT s.spec_version FROM systems s WHERE s.id=thread_current_system($1)`,
        [run.thread_id],
      );
      if (runSpec.rows[0]?.spec_version === "1.0" && runnerId.startsWith("desktop-")) {
        return writeProblem(
          reply,
          409,
          "OpenShip 1.0 run is server-managed",
          "The API runner owns the isolated project/control workspace for OpenShip 1.0 runs.",
          "openship_server_runner_required",
        );
      }
      const claimed = await claimAgentRunById(runId, runnerId);
      if (!claimed) {
        return writeProblem(reply, 409, "Run unavailable", "Run is not available for claiming");
      }

      await publishEvent({
        type: "assistant.run.progress",
        aggregateType: "assistant-run",
        aggregateId: runId,
        orgId: user.orgId,
        traceId: run.thread_id,
        payload: {
          status: claimed.status,
          runnerId,
          threadId: run.thread_id,
        },
      });

      const completedRun = await getAgentRunById(runId);
      if (!completedRun) return notFoundProblem(reply, "Run not found");
      return mapAssistantRunRow(completedRun);
    },
  );

  app.post<{ Params: { runId: string }; Body: V1RunCompleteBody }>(
    "/assistant-runs/:runId/complete",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const runId = req.params.runId;
      if (!isUuid(runId)) {
        return writeProblem(reply, 400, "Invalid run id", "runId must be a UUID.");
      }
      if (req.body?.status !== "success" && req.body?.status !== "failed") {
        return writeProblem(reply, 400, "Invalid status", "status must be success or failed");
      }

      const run = await getAgentRunById(runId);
      if (!run) {
        return notFoundProblem(reply, "Run not found");
      }

      const thread = await resolveThreadAccess(run.thread_id, user.id);
      if (!thread) {
        return forbiddenProblem(reply, "Access denied for this run.");
      }

      const messages = Array.isArray(req.body?.messages)
        ? req.body.messages.filter((message) => typeof message === "string").map((message) => message.trim()).filter(Boolean)
        : [];

      if (messages.length === 0) {
        return writeProblem(reply, 400, "Invalid payload", "messages must be a non-empty list of strings");
      }

      const success = req.body.status === "success";
      const changes = parseRunPlanChanges(req.body.changes);
      const openShipBundleFiles = parseOpenShipBundleFiles(req.body.openShipBundleFiles);
      if (openShipBundleFiles === null) {
        return writeProblem(
          reply,
          400,
          "Invalid payload",
          "openShipBundleFiles must be a list of bundle files.",
        );
      }

      const initialNormalizedMessages = sanitizeV1AgentRunMessages(messages);
      let completionStatus: "success" | "failed" = success ? "success" : "failed";
      let completionError = req.body.error;
      let completionMessages = [...initialNormalizedMessages];

      if (completionStatus === "success" && changes.length > 0 && openShipBundleFiles.length > 0) {
        try {
          await applyOpenShipBundleToThreadSystem({
            threadId: run.thread_id,
            bundleFiles: openShipBundleFiles,
          });
          await publishThreadMatrixChanged(run.thread_id, user, run.thread_id);
        } catch (error: unknown) {
          const reconcileError = error instanceof Error ? error.message : "Agent execution failed.";
          const reconcileMessage = `OpenShip reconciliation failed: ${reconcileError}`;
          completionStatus = "failed";
          completionError = completionError
            ? `${completionError} / ${reconcileMessage}`
            : reconcileMessage;
          completionMessages = [...completionMessages, reconcileMessage];
        }
      }

      let completionMessageRows: V1RunChatMessage[] = [];
      const updated = await updateAgentRunResult(
        runId,
        completionStatus,
        {
          status: completionStatus,
          messages: completionMessages,
          changes,
          error: completionError,
        },
        completionError,
        req.body.runnerId,
      );

      if (updated) {
        const completionRecord = await persistV1DesktopAgentRunCompletionMessage(
          run.thread_id,
          {
            status: completionStatus,
            messages: completionMessages,
            changes,
            error: completionError,
          },
          completionStatus,
        );

        if (completionRecord?.responseActionId) {
          const responseMessageRows = await query<{
            id: string;
            action_id: string;
            action_type: string;
            action_position: number;
            role: "User" | "Assistant" | "System";
            content: string;
            created_at: string;
          }>(
            `SELECT m.id, m.action_id, m.role, m.content, m.created_at, a.position AS action_position, a.type::text AS action_type
               FROM messages m
               JOIN actions a ON a.thread_id = m.thread_id AND a.id = m.action_id
              WHERE m.thread_id = $1 AND m.action_id = $2
              ORDER BY m.position`,
            [run.thread_id, completionRecord.responseActionId],
          );
          completionMessageRows = responseMessageRows.rows.map((row) => ({
            id: row.id,
            actionId: row.action_id,
            actionType: row.action_type,
            actionPosition: row.action_position,
            role: row.role,
            content: row.content,
            senderName: formatAssistantModelLabel(run.model),
            createdAt: new Date(row.created_at).toISOString(),
          }));
        }
      }

      req.log.info(
        {
          runId,
          updated,
          status: completionStatus,
          runnerId: req.body.runnerId,
        },
        "updateAgentRunResult result",
      );

      if (!updated) {
        req.log.warn(
          {
          runId,
          status: completionStatus,
          runnerId: req.body.runnerId,
        },
        "updateAgentRunResult no-op",
        );
        return writeProblem(reply, 409, "Run cannot be completed", "Run was already finalized");
      }

      await publishEvent({
        type: completionStatus === "success" ? "assistant.run.completed" : "assistant.run.failed",
        aggregateType: "assistant-run",
        aggregateId: runId,
        orgId: user.orgId,
        traceId: run.thread_id,
        payload: {
          threadId: run.thread_id,
          status: completionStatus,
          messages,
        },
      });
      await publishEvent({
        type: "chat.session.finished",
        aggregateType: "thread",
        aggregateId: run.thread_id,
        orgId: user.orgId,
        traceId: run.thread_id,
        payload: {
          threadId: run.thread_id,
          runId,
          status: completionStatus,
        },
      });

      const completedRun = await getAgentRunById(runId);
      if (!completedRun) return notFoundProblem(reply, "Run not found");
      const response = mapAssistantRunRow(completedRun);
      return completionMessageRows.length > 0
        ? { ...response, messages: completionMessageRows }
        : response;
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/assistant-runs/:runId/cancel",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const runId = req.params.runId;
      if (!isUuid(runId)) {
        return writeProblem(reply, 400, "Invalid run id", "runId must be a UUID.");
      }
      const run = await getAgentRunById(runId);
      if (!run) {
        return notFoundProblem(reply, "Run not found");
      }

      const thread = await resolveThreadAccess(run.thread_id, user.id);
      if (!thread) {
        return forbiddenProblem(reply, "Access denied for this run.");
      }

      const canceled = await query<V1AgentRunRow>(
        `UPDATE agent_runs
            SET status = 'cancelled', run_result_status = 'failed', run_error = COALESCE($2, run_error),
                completed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status IN ('queued', 'running')
          RETURNING id, thread_id, model, status, mode, prompt, system_prompt, run_result_status,
                    run_result_messages, run_result_changes, run_error, created_at, started_at, completed_at`,
        [runId, "Cancelled by user"],
      );

      if (canceled.rowCount === 0) {
        return writeProblem(reply, 409, "Run cannot be cancelled", "Run is already finalized");
      }

      await publishEvent({
        type: "assistant.run.cancelled",
        aggregateType: "assistant-run",
        aggregateId: runId,
        orgId: user.orgId,
        traceId: run.thread_id,
        payload: {
          threadId: run.thread_id,
          status: "cancelled",
        },
      });
      await publishEvent({
        type: "chat.session.finished",
        aggregateType: "thread",
        aggregateId: run.thread_id,
        orgId: user.orgId,
        traceId: run.thread_id,
        payload: {
          threadId: run.thread_id,
          runId,
          status: "cancelled",
        },
      });

      return mapAssistantRunRow(canceled.rows[0] as V1AgentRunRow);
    },
  );

  app.get<{ Querystring: { since?: string; limit?: number } }>(
    "/events",
    async (req, reply) => {
      const user = (req as V1AuthRequest).auth;
      const limit = parsePositiveInt(req.query.limit, 100, 1, 500);

      const cursor = readEventCursor(req.query.since);
      if (req.query.since && !cursor) {
        return writeProblem(
          reply,
          400,
          "Invalid cursor",
          "since must be RFC3339 timestamp or event cursor.",
        );
      }

      const items = await queryEvents({
        orgId: user.orgId,
        since: cursor,
        limit,
      });

      return {
        items: items.items,
        nextCursor: items.nextCursor,
        page: 1,
        pageSize: limit,
      };
    },
  );

  app.get<{ Querystring: { since?: string; limit?: number } }>(
    "/events/stream",
    async (req, reply) => {
      const requestOrigin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
      const allowOrigin = requestOrigin?.trim() || "*";
      reply.raw.setHeader("Access-Control-Allow-Origin", allowOrigin);
      reply.raw.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      reply.raw.setHeader("Access-Control-Allow-Headers", "Authorization, Last-Event-ID, Cache-Control, Content-Type");
      reply.raw.setHeader("Access-Control-Expose-Headers", "Cache-Control");
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");

      const user = (req as V1AuthRequest).auth;
      const limit = parsePositiveInt(req.query.limit, 100, 1, 500);

      let cursor: string | undefined;
      const lastEventId = req.headers["last-event-id"];
      const lastEventIdHeader = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
      if (typeof lastEventIdHeader === "string" && lastEventIdHeader.trim()) {
        cursor = readEventCursor(lastEventIdHeader);
      } else if (req.query.since) {
        cursor = readEventCursor(req.query.since);
      }

      if (req.query.since && !cursor) {
        return writeProblem(
          reply,
          400,
          "Invalid cursor",
          "since must be RFC3339 timestamp or event cursor.",
        );
      }

      reply.raw.write("retry: 3000\n\n");

      let closed = false;
      const heartbeat = setInterval(() => {
        if (closed) return;
        reply.raw.write(": heartbeat\n\n");
      }, 15000);

      reply.raw.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
      });

      while (!closed) {
        const queryResult = await queryEvents({
          orgId: user.orgId,
          since: cursor,
          limit,
        });

        for (const item of queryResult.items) {
          const itemCursor = encodeCursor(item);
          reply.raw.write(`id: ${itemCursor}\n`);
          reply.raw.write(`event: ${item.type}\n`);
          reply.raw.write(`data: ${JSON.stringify(item)}\n\n`);
          cursor = itemCursor;
        }

        if (queryResult.items.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      clearInterval(heartbeat);
      reply.raw.end();
    },
  );
}
