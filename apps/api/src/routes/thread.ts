import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { AgentRunPlanChange } from "@acx/agent-runtime";
import pool, { query } from "../db.js";
import {
  applyOpenShipBundleToThreadSystem,
  type OpenShipBundleFile,
} from "../openship-sync.js";
import {
  claimAgentRunById,
  enqueueAgentRunWithWait,
  getAgentRunById,
  waitForAgentRunCompletion,
  updateAgentRunResult,
} from "../agent-queue.js";
import { verifyOptionalAuth, type AuthUser } from "../auth.js";
import { decryptToken, encryptToken } from "../integrations/crypto.js";
import { getProviderClient, sourceTypeToProvider, type DocSourceType } from "../integrations/index.js";
import { generateOpenShipFileBundle } from "../agent-runner.js";

const EDIT_ROLES = new Set(["Owner", "Editor"]);
const SYSTEM_PROMPT_CONCERN = "__system_prompt__";
type NodeOwnership = "first_party" | "third_party";
type NodeBoundary = "internal" | "external";

function normalizeNodeOwnership(value: string | null): NodeOwnership {
  return value === "third_party" ? "third_party" : "first_party";
}

function normalizeNodeBoundary(value: string | null): NodeBoundary {
  return value === "external" ? "external" : "internal";
}

function parsePositiveMs(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const AGENT_RUN_TIMEOUT_MS = parsePositiveMs(process.env.ACX_AGENT_RUN_TIMEOUT_MS ?? "120000", 120000);
const AGENT_RUN_POLL_MS = parsePositiveMs(process.env.ACX_AGENT_RUN_POLL_MS ?? "700", 700);
const AGENT_RUN_SLOT_WAIT_MS = parsePositiveMs(process.env.ACX_AGENT_RUN_SLOT_WAIT_MS ?? "120000", 120000);
const AGENT_RUN_ENQUEUE_POLL_MS = parsePositiveMs(process.env.ACX_AGENT_RUN_ENQUEUE_POLL_MS ?? "500", 500);
const DEFAULT_SYSTEM_PROMPT =
  "You are a staff software engineer with top design and implementation skills. " +
  "Start by reading AGENTS.md. " + 
  "You will update the system description and implementation in ./openship (or not if there is no update) " +
  "and add to a file called SUMMARY.md a description of the plan executed, use Markdown. " +
  "If changes were made during the run, check that the updated ./openship directory is fully compliant with the OpenShip description and write that you checked that in the summary. " +
  "If changes are to be made, keep the changes to a minimum. In particular do not update name if existing objects like node or names unless it is absolutely necessary. " +
  "Node IDs and directory names should not be changed " +
  "Your response should be a summary of everything that has been done. No need to include checks and validation made.";

function extractAgentRunMessageText(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return [];

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractAgentRunMessageText(item, depth + 1));
  }

  if (typeof value === "object") {
    const typedValue = value as Record<string, unknown>;

    if (typeof typedValue.text === "string") {
      return [typedValue.text];
    }

    const candidates = [
      typedValue.content,
      typedValue.message,
      typedValue.response,
      typedValue.result,
      typedValue.summary,
      typedValue.output,
      typedValue.aggregated_output,
      typedValue.items,
    ];
    return candidates.flatMap((entry) => extractAgentRunMessageText(entry, depth + 1));
  }

  return [];
}

function normalizeAgentRunMessages(messages: string[]): string[] {
  const unique = new Set<string>();
  const normalized: string[] = [];

  for (const rawMessage of messages) {
    const trimmed = rawMessage.trim();
    if (!trimmed) continue;

    const withoutPrefix = trimmed.replace(/^\[[^\]]+\]\s*/g, "");

    let candidateTexts: string[] = [];
    try {
      const parsed = JSON.parse(withoutPrefix) as unknown;
      candidateTexts = extractAgentRunMessageText(parsed)
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
const MATRIX_REFS_CONSTRAINT_FRAGMENT = "violates foreign key constraint \"matrix_refs_system_id_doc_hash_fkey\"";

function isReconciliationNoiseMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.startsWith(RECONCILIATION_MESSAGE_PREFIX)
    || lowered.includes("insert or update on table \"matrix_refs\"")
    || lowered.includes(MATRIX_REFS_CONSTRAINT_FRAGMENT);
}

function sanitizeAgentRunMessages(messages: string[]): string[] {
  return normalizeAgentRunMessages(messages)
    .map((message) => message.trim())
    .filter((message) => message.length > 0)
    .filter((message) => !isReconciliationNoiseMessage(message));
}

function summarizeRunMessages(status: "success" | "failed", messages: string[]): string[] {
  const sanitized = sanitizeAgentRunMessages(messages);
  return sanitized.length > 0 ? sanitized : [status === "failed" ? "Execution failed." : "Execution completed."];
}

type AssistantExecutor = "backend" | "desktop";

type ThreadStatus = "open" | "closed" | "committed";

interface ThreadContextRow {
  thread_id: string;
  project_thread_id: number;
  project_id: string;
  title: string | null;
  description: string | null;
  status: ThreadStatus;
  created_at: Date;
  created_by_handle: string;
  project_name: string;
  owner_handle: string;
  access_role: string | null;
}

interface SystemRow {
  system_id: string;
}

interface SystemRootNodeRow {
  root_node_id: string;
}

interface SystemPromptRow {
  hash: string;
  text: string;
  title: string;
}

interface TopologyNodeRow {
  id: string;
  name: string;
  kind: string;
  parent_id: string | null;
  layout_x: number | null;
  layout_y: number | null;
  ownership: string | null;
  boundary: string | null;
}

interface TopologyEdgeRow {
  id: string;
  type: string;
  from_node_id: string;
  to_node_id: string;
  protocol: string | null;
  layer7: string | null;
}

interface ConcernRow {
  name: string;
  position: number;
}

interface MatrixRefRow {
  node_id: string;
  concern: string;
  doc_hash: string;
  ref_type: "Document" | "Skill" | "Prompt";
  doc_title: string;
  doc_kind: "Document" | "Skill" | "Prompt";
  doc_language: string;
  doc_source_type: DocSourceType;
  doc_source_url: string | null;
  doc_source_external_id: string | null;
  doc_source_metadata: Record<string, unknown> | null;
  doc_source_connected_user_id: string | null;
}

interface MatrixDocumentRow {
  hash: string;
  kind: "Document" | "Skill" | "Prompt";
  title: string;
  language: string;
  text: string;
  source_type: DocSourceType;
  source_url: string | null;
  source_external_id: string | null;
  source_metadata: Record<string, unknown> | null;
  source_connected_user_id: string | null;
}

interface ArtifactRow {
  id: string;
  node_id: string;
  concern: string;
  type: string;
  language: string;
  text: string | null;
}

interface ChatMessageRow {
  id: string;
  action_id: string;
  action_position: number;
  action_type: string;
  role: "User" | "Assistant" | "System";
  content: string;
  created_at: Date;
}

interface ThreadChatMessage {
  id: string;
  actionId: string;
  role: "User" | "Assistant" | "System";
  actionType: string;
  actionPosition: number;
  content: string;
  createdAt: Date;
}

interface ChatActionRow {
  id: string;
  position: number;
  type: string;
  title: string | null;
}

interface AssistantRunActionRow {
  id: string;
  position: number;
  type: string;
}

interface ActionPlanRow {
  id: string;
  position: number;
}

interface MessageReferenceRow {
  id: string;
  role: "User" | "Assistant" | "System";
  content: string;
}

type AssistantRunPlanChange = AgentRunPlanChange;

interface AssistantRunMessageLookupRow {
  id: string;
  role: "User" | "Assistant" | "System";
  content: string;
  created_at: Date;
  action_type: string;
  action_position: number;
}

interface AssistantRunMessageRow {
  action_id: string;
  action_type: string;
  action_position: number;
  id: string;
  role: "User" | "Assistant" | "System";
  content: string;
  created_at: Date;
}

interface AssistantRunCompletionRecord {
  responseActionId: string;
}

interface AssistantRunPlanResponse {
  planActionId: string | null;
  planResponseActionId: string | null;
  executeActionId: string | null;
  executeResponseActionId: string | null;
  updateActionId: string | null;
  filesChanged: {
    kind: "Create" | "Update" | "Delete";
    path: string;
    fromHash?: string;
    toHash?: string;
  }[];
  summary: {
    status: "success" | "failed";
    messages: string[];
  };
  changesCount: number;
  messages: ThreadChatMessage[];
  systemId: string;
  threadState?: ThreadDetailPayload;
  model?: string;
}

interface AssistantRunQueuedResponse {
  runId: string;
  status: "queued" | "running";
  message: "Run queued for desktop execution";
  systemId: string;
  model?: string;
}

interface AssistantRunRequestBody {
  chatMessageId: string | null;
  mode: "direct" | "plan";
  planActionId: string | null;
  executor: AssistantExecutor;
  model: string;
  wait: boolean;
}

interface AssistantRunClaimRequestBody {
  runnerId?: string;
}

interface AssistantRunCompleteRequestBody {
  status: "success" | "failed";
  messages: string[];
  changes: AgentRunPlanChange[];
  error?: string;
  runnerId?: string;
  openShipBundleFiles?: OpenShipBundleFile[];
}

interface OpenShipBundleDescriptorFile {
  path: string;
  content: string;
}

interface OpenShipBundleDescriptor {
  threadId: string;
  systemId: string;
  generatedAt: string;
  files: OpenShipBundleDescriptorFile[];
}

interface AssistantRunRow {
  id: string;
  thread_id: string;
  project_id: string;
  requested_by_user_id: string | null;
  model: string;
  mode: "direct" | "plan";
  plan_action_id: string | null;
  chat_message_id: string | null;
  prompt: string;
  system_prompt: string | null;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  runner_id: string | null;
  run_result_status: "success" | "failed" | null;
  run_result_messages: string[] | null;
  run_result_changes: AssistantRunPlanChange[] | null;
  run_error: string | null;
  created_at: string;
}

interface BeginActionRow {
  output_system_id: string | null;
}

function isFinalizedThreadStatus(status: string): status is "closed" | "committed" {
  return status === "closed" || status === "committed";
}

interface UpsertThreadRow {
  id: string;
  project_thread_id: number;
  title: string;
  description: string | null;
  status: ThreadStatus;
}

interface ClonedThreadRow {
  thread_id: string;
  project_thread_id: number;
  title: string;
  description: string | null;
  status: ThreadStatus;
  created_at: Date;
  created_by_handle: string;
  project_name: string;
  owner_handle: string;
}

interface ChangedRow {
  changed: number;
}

interface ThreadContext {
  threadId: string;
  projectThreadId: number;
  projectId: string;
  title: string;
  description: string | null;
  status: ThreadStatus;
  createdAt: Date;
  createdByHandle: string;
  projectName: string;
  ownerHandle: string;
  accessRole: string;
}

function getAuthUser(req: FastifyRequest): AuthUser | null {
  return (req as FastifyRequest & { auth?: AuthUser }).auth ?? null;
}

function getViewerUserId(req: FastifyRequest): string | null {
  return getAuthUser(req)?.id ?? null;
}

interface CloneThreadBody {
  title?: string;
  description?: string;
}

function extractAssistantRunChangedFiles(changes: AssistantRunPlanChange[]): AssistantRunPlanResponse["filesChanged"] {
  return changes
    .filter((change) => change.target_table === "OpenShipBundleFile")
    .map((change) => ({
      kind: change.operation,
      path: String(change.target_id.path ?? ""),
      fromHash: (change.previous as { hash?: string } | null)?.hash,
      toHash: (change.current as { hash?: string } | null)?.hash,
    }));
}

async function collectOpenShipBundleDescriptorFiles(bundleDir: string): Promise<OpenShipBundleDescriptorFile[]> {
  const entries = await readdir(bundleDir, { withFileTypes: true });
  const files: OpenShipBundleDescriptorFile[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = join(bundleDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectOpenShipBundleDescriptorFiles(childPath);
      files.push(...nested.map((file) => ({
        path: join(entry.name, file.path).replace(/\\/g, "/"),
        content: file.content,
      })));
      continue;
    }
    if (!entry.isFile()) continue;

    const content = await readFile(childPath, "utf8").catch(() => null);
    if (content === null) continue;
    files.push({
      path: entry.name,
      content,
    });
  }

  return files;
}

async function buildOpenShipBundleDescriptor(threadId: string, contextSystemId: string): Promise<OpenShipBundleDescriptor> {
  const workspace = await mkdtemp(join(tmpdir(), "acx-openship-bundle-"));
  try {
    const bundleDir = await generateOpenShipFileBundle(threadId, workspace);
    const files = await collectOpenShipBundleDescriptorFiles(bundleDir);
    return {
      threadId,
      systemId: contextSystemId,
      generatedAt: new Date().toISOString(),
      files,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

interface MatrixDoc {
  hash: string;
  title: string;
  kind: "Document" | "Skill" | "Prompt";
  language: string;
  refType: "Document" | "Skill" | "Prompt";
  sourceType?: DocSourceType;
  sourceUrl?: string | null;
  sourceExternalId?: string | null;
  sourceMetadata?: Record<string, unknown> | null;
  sourceConnectedUserId?: string | null;
}

interface ArtifactRef {
  id: string;
  type: string;
  language: string;
  text: string | null;
}

interface MatrixCell {
  nodeId: string;
  concern: string;
  docs: MatrixDoc[];
  artifacts: ArtifactRef[];
}

interface MatrixRefBody {
  nodeId: string;
  concern?: string;
  concerns?: string[];
  docHash: string;
  refType: "Document" | "Skill" | "Prompt";
}

interface UserIntegrationRow {
  status: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: Date | null;
}

type IntegrationReconnectStatus = "disconnected" | "needs_reauth";

interface IntegrationMissingError extends Error {
  code: "INTEGRATION_RECONNECT";
  provider: "notion" | "google";
  status: IntegrationReconnectStatus;
}

interface NotionApiError extends Error {
  provider: "notion";
  status: number;
  code: "NOTION_API_ERROR";
  reason: string;
  statusText: string;
  responseBody?: string;
  requestUrl?: string;
}

type DocKind = "Document" | "Skill" | "Prompt";

interface MatrixDocumentAttach {
  nodeId: string;
  concern: string;
  concerns: string[];
  refType: DocKind;
  docHash?: string;
}

interface MatrixDocumentCreateBodyBase {
  kind: DocKind;
  sourceType: DocSourceType;
  language: string;
  title?: string;
  attach?: MatrixDocumentAttach;
}

interface MatrixDocumentCreateBodyLocal extends MatrixDocumentCreateBodyBase {
  sourceType: "local";
  name: string;
  description: string;
  body: string;
}

interface MatrixDocumentCreateBodyRemote extends MatrixDocumentCreateBodyBase {
  sourceType: Exclude<DocSourceType, "local">;
  sourceUrl: string;
}

type MatrixDocumentCreateBody = MatrixDocumentCreateBodyLocal | MatrixDocumentCreateBodyRemote;

interface MatrixDocumentReplaceBody {
  title?: string;
  name?: string;
  description?: string;
  language?: string;
  body?: string;
}

type IntegrationConnectionStatus = "connected" | "disconnected" | "expired" | "needs_reauth";
interface IntegrationStatusResponse {
  provider: "notion" | "google";
  status: IntegrationConnectionStatus;
}

interface ParsedDocumentText {
  name: string;
  description: string;
  body: string;
}

const CODEX_MODEL = "gpt-5.3-codex";
const LEGACY_CODEX_MODEL = "codex-5.3";
const CLAUDE_OPUS_4_7_MODEL = "claude-opus-4-7";
const GPT_5_5_MODEL = "gpt-5.5";
const GPT_5_4_MODEL = "gpt-5.4";
const ALLOWED_ASSISTANT_MODELS = ["claude-opus-4-6", CLAUDE_OPUS_4_7_MODEL, "claude-sonnet-4-6", CODEX_MODEL, LEGACY_CODEX_MODEL, GPT_5_5_MODEL, GPT_5_4_MODEL] as const;
type AssistantModel = (typeof ALLOWED_ASSISTANT_MODELS)[number];
const DEFAULT_ASSISTANT_MODEL: AssistantModel = "claude-opus-4-6";

interface TopologyLayoutBody {
  positions: Array<{
    nodeId: string;
    x: number;
    y: number;
  }>;
}

interface ThreadPatchBody {
  title?: string;
  description?: string | null;
}

interface ChatMessageBody {
  content: string;
}

function parseThreadId(threadId: string): number | null {
  const parsed = Number(threadId);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

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

function parseAssistantRunMode(value: unknown): "direct" | "plan" | null {
  if (value !== "direct" && value !== "plan") return null;
  return value;
}

function parseOptionalUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function parseAssistantRunRequest(body: unknown): AssistantRunRequestBody | null {
  if (!body || typeof body !== "object") return null;
  const payload = body as Partial<{
    chatMessageId: unknown;
    mode: unknown;
    planActionId: unknown;
    executor: unknown;
    model: unknown;
    wait: unknown;
  }>;
  const mode = parseAssistantRunMode(payload.mode);
  if (!mode) return null;

  const chatMessageId = parseOptionalUuid(payload.chatMessageId);
  const planActionId = parseOptionalUuid(payload.planActionId);
  const executorRaw = typeof payload.executor === "string" ? payload.executor : "backend";
  if (payload.wait !== undefined && payload.wait !== true && payload.wait !== false) return null;
  const wait = payload.wait === undefined ? true : payload.wait;
  const executor: AssistantExecutor = executorRaw === "desktop" ? "desktop" : "backend";
  const rawModel = payload.model;
  let model: AssistantModel;
  if (rawModel === undefined) {
    model = DEFAULT_ASSISTANT_MODEL;
  } else {
    const parsedModel = resolveAssistantModel(rawModel);
    if (parsedModel === null) return null;
    model = normalizeAssistantModel(parsedModel);
  }

  return { mode, chatMessageId, planActionId, executor, model, wait };
}

async function getAssistantRunTriggerMessage(threadId: string, chatMessageId: string | null): Promise<AssistantRunMessageLookupRow | null> {
  if (chatMessageId) {
    const result = await query<AssistantRunMessageLookupRow>(
      `SELECT m.id, m.role, m.content, m.created_at, a.type AS action_type, a.position AS action_position
       FROM messages m
       JOIN actions a ON a.thread_id = m.thread_id AND a.id = m.action_id
       WHERE m.thread_id = $1 AND m.id = $2 AND m.role = 'User'
       LIMIT 1`,
      [threadId, chatMessageId],
    );
    if (result.rowCount) return result.rows[0];
  }

  const fallback = await query<AssistantRunMessageLookupRow>(
    `SELECT m.id, m.role, m.content, m.created_at, a.type AS action_type, a.position AS action_position
     FROM messages m
     JOIN actions a ON a.thread_id = m.thread_id AND a.id = m.action_id
     WHERE m.thread_id = $1 AND m.role = 'User'
     ORDER BY a.position DESC, m.position DESC
     LIMIT 1`,
    [threadId],
  );

  return fallback.rows[0] ?? null;
}

async function loadAction(contextThreadId: string, actionId: string): Promise<AssistantRunActionRow | null> {
  const result = await query<AssistantRunActionRow>(
    `SELECT id, type, position FROM actions WHERE thread_id = $1 AND id = $2`,
    [contextThreadId, actionId],
  );
  return result.rows[0] ?? null;
}

function assistantRunSummary(status: "success" | "failed", messages: string[]): AssistantRunPlanResponse["summary"] {
  return { status, messages };
}

function mapAssistantRunMessages(rows: AssistantRunMessageRow[]): AssistantRunPlanResponse["messages"] {
  return rows.map((row) => ({
    id: row.id,
    actionId: row.action_id,
    role: row.role,
    actionType: row.action_type,
    actionPosition: row.action_position,
    content: row.content,
    createdAt: row.created_at,
  }));
}

function mapChatMessages(rows: ChatMessageRow[]): ThreadChatMessage[] {
  return rows.map((row) => ({
    id: row.id,
    actionId: row.action_id,
    actionType: row.action_type,
    actionPosition: row.action_position,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

function buildNodeScopedSummary(
  nodeName: string | null,
  title: string,
  verb: "added" | "removed" | "updated",
): string {
  if (nodeName) {
    return `In the ${nodeName}, the document "${title}" was ${verb}.`;
  }
  return `The document "${title}" was ${verb}.`;
}

function buildDocumentAddSummary(title: string, nodeName: string | null): string {
  return buildNodeScopedSummary(nodeName, title, "added");
}

function buildDocumentRemoveSummary(title: string, nodeName: string | null): string {
  return buildNodeScopedSummary(nodeName, title, "removed");
}

function buildDocumentCreateSummary(
  title: string,
  sourceType: DocSourceType,
  nodeName: string | null,
  hasAttachment: boolean,
): string {
  if (hasAttachment) {
    return buildNodeScopedSummary(nodeName, title, "added");
  }
  if (sourceType === "local") {
    return `The document "${title}" was created.`;
  }
  return `The document "${title}" was imported.`;
}

function buildDocumentModifySummary(
  previousTitle: string,
  nextTitle: string,
  nodeNames: string[],
): string {
  const title = nextTitle || previousTitle;
  if (nodeNames.length === 1) {
    return `In the ${nodeNames[0]}, the document "${title}" was updated.`;
  }
  if (nodeNames.length > 1) {
    return `In ${nodeNames.length} nodes, the document "${title}" was updated.`;
  }
  return `The document "${title}" was updated.`;
}

async function getDocumentTitleByHash(
  client: PoolClient,
  systemId: string,
  hash: string,
): Promise<string | null> {
  const result = await client.query<{ title: string }>(
    `SELECT title
     FROM documents
     WHERE system_id = $1 AND hash = $2
     LIMIT 1`,
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
    `SELECT name
     FROM nodes
     WHERE system_id = $1 AND id = $2
     LIMIT 1`,
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
) {
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
): Promise<ThreadChatMessage[]> {
  const messagesResult = await client.query<ChatMessageRow>(
    `SELECT m.id, m.action_id, m.role, m.content, m.created_at, a.position AS action_position, a.type AS action_type
     FROM messages m
     JOIN actions a ON a.thread_id = m.thread_id AND a.id = m.action_id
     WHERE m.thread_id = $1 AND m.action_id = $2
     ORDER BY m.position`,
    [threadId, actionId],
  );
  return mapChatMessages(messagesResult.rows);
}

function generatePlanResponseContent(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return "Plan request received. Please provide a message with concrete edits to execute.";
  }
  return `Proposed plan:
1. Parse the user request: "${trimmed}".
2. Identify impacted resources in the thread.
3. Execute a minimal, safe update.
4. Return a concise summary and changed artifacts.`;
}

function runExecutionError(error: unknown): string {
  return error instanceof Error ? error.message : "Agent execution failed.";
}

function mapAgentRunRowToResponse(row: {
  runId: string;
  systemId: string;
  model?: string;
  runResultStatus?: "success" | "failed" | null;
  runResultMessages?: string[] | null;
  runResultChanges?: AssistantRunPlanChange[] | null;
  runError?: string | null;
  threadStatus: "queued" | "running" | "success" | "failed" | "cancelled";
  messages?: AssistantRunMessageRow[];
  threadState?: ThreadDetailPayload;
}): AssistantRunPlanResponse | AssistantRunQueuedResponse {
  if (row.threadStatus !== "success" && row.threadStatus !== "failed" && row.threadStatus !== "cancelled") {
      return {
        runId: row.runId,
        status: row.threadStatus,
        message: "Run queued for desktop execution",
        model: row.model,
        systemId: row.systemId,
      };
    }

  const status = row.threadStatus === "cancelled" ? "failed" : row.runResultStatus ?? row.threadStatus;
  const messages = row.runResultMessages && row.runResultMessages.length > 0
    ? sanitizeAgentRunMessages(row.runResultMessages)
    : [];
  const fallbackMessages = row.runError ? sanitizeAgentRunMessages([row.runError]) : [];
  const summaryMessages = messages.length > 0
    ? messages
    : (fallbackMessages.length > 0 ? fallbackMessages : ["No execution output."]);
  const changes = row.runResultChanges ?? [];
  return {
    model: row.model,
    planActionId: null,
    planResponseActionId: null,
    executeActionId: null,
    executeResponseActionId: null,
    updateActionId: null,
    filesChanged: extractAssistantRunChangedFiles(changes),
    summary: assistantRunSummary(status, summaryMessages),
    changesCount: status === "success" ? changes.length : 0,
    messages: row.messages ? mapAssistantRunMessages(row.messages) : [],
    systemId: row.systemId,
    ...(row.threadState ? { threadState: row.threadState } : {}),
  };
}

async function getAgentRunByThreadId(threadId: string, runId: string): Promise<AssistantRunRow | null> {
  const result = await query<AssistantRunRow>(
    `SELECT id, thread_id, project_id, requested_by_user_id, model, mode, plan_action_id, chat_message_id,
            prompt, system_prompt, status, runner_id, run_result_status,
            run_result_messages, run_result_changes, run_error, created_at
       FROM agent_runs
      WHERE id = $1 AND thread_id = $2`,
    [runId, threadId],
  );
  return result.rowCount ? result.rows[0] : null;
}

async function persistDesktopAgentRunCompletionMessage(
  client: PoolClient,
  threadId: string,
  payload: AssistantRunCompleteRequestBody,
  runResultStatus: "success" | "failed",
): Promise<AssistantRunCompletionRecord | null> {
  const responseActionId = randomUUID();
  const normalizedMessages = sanitizeAgentRunMessages(payload.messages);
  const nonChangeMessages = normalizedMessages.filter(
    (message) => !message.startsWith("OpenShip changes:"),
  );

  const responseMessages = nonChangeMessages.length > 0
    ? nonChangeMessages
    : payload.changes.length > 0
      ? normalizedMessages
      : [
          ...normalizedMessages.filter((message) => !message.startsWith("OpenShip changes:")),
          payload.status === "failed"
            ? (payload.error ?? "Execution failed.")
            : "Execution completed.",
        ];
  const uniqueResponseMessages = [...new Set(responseMessages)];
  if (uniqueResponseMessages.length === 0) {
    return null;
  }

  const responseMessage = uniqueResponseMessages.join(" | ");
  await client.query(
    `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
    [threadId, responseActionId, "ExecuteResponse", "Agent execution response"],
  );
  await client.query("SELECT commit_action_empty($1, $2)", [threadId, responseActionId]);
  await client.query(
    `INSERT INTO messages (id, thread_id, action_id, role, content, position)
     VALUES ($1, $2, $3, 'Assistant'::message_role, $4, 1)`,
    [randomUUID(), threadId, responseActionId, responseMessage],
  );

  if (runResultStatus === "success" && payload.changes.length > 0) {
    const changeActionId = randomUUID();
    await client.query(
      `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
      [threadId, changeActionId, "Update", "Agent execution changes"],
    );
    for (const change of payload.changes) {
      await client.query(
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
    await client.query("SELECT commit_action_empty($1, $2)", [threadId, changeActionId]);
  }

  return { responseActionId };
}

function resolvePlanActionFromResponse(
  actionType: string,
  responseIndex: number,
  all: Array<{ type: string; position: number; id: string }>,
): string | null {
  if (actionType === "Plan") return null;
  if (actionType === "PlanResponse") {
    const prior = all
      .filter((entry) => entry.type === "Plan" && entry.position < responseIndex)
      .sort((a, b) => b.position - a.position)[0];
    return prior?.id ?? null;
  }
  return null;
}

function isConnectedProvider(provider: string): provider is "notion" | "google" {
  return provider === "notion" || provider === "google";
}

async function markIntegrationNeedsReauth(userId: string, provider: "notion" | "google") {
  await query(
    `UPDATE user_integrations
     SET status = 'needs_reauth',
         updated_at = now()
     WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
}

function createIntegrationError(
  provider: "notion" | "google",
  status: IntegrationReconnectStatus,
): IntegrationMissingError {
  const error = new Error(`Integration ${provider} requires reconnect`) as IntegrationMissingError;
  error.code = "INTEGRATION_RECONNECT";
  error.provider = provider;
  error.status = status;
  return error;
}

function isIntegrationMissingError(value: unknown): value is IntegrationMissingError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: string }).code === "INTEGRATION_RECONNECT"
  );
}

function isNotionApiError(value: unknown): value is NotionApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: string }).code === "NOTION_API_ERROR"
  );
}

async function getIntegrationAccessToken(userId: string, sourceType: Exclude<DocSourceType, "local">): Promise<string> {
  const provider = sourceTypeToProvider(sourceType);
  const result = await query<UserIntegrationRow>(
    `SELECT status, access_token_enc, refresh_token_enc, token_expires_at
     FROM user_integrations
     WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );

  if (result.rowCount === 0) {
    throw createIntegrationError(provider, "disconnected");
  }

  const row = result.rows[0];
  if (row.status === "disconnected") {
    throw createIntegrationError(provider, "disconnected");
  }
  if (row.status === "needs_reauth") {
    throw createIntegrationError(provider, "needs_reauth");
  }

  if (!row.access_token_enc) {
    throw createIntegrationError(provider, "needs_reauth");
  }

  const providerClient = getProviderClient(provider);
  const isExpired = row.token_expires_at instanceof Date
    ? row.token_expires_at.getTime() <= Date.now()
    : false;

  const existingAccessToken = decryptToken(row.access_token_enc);

  if (!isExpired) {
    return existingAccessToken;
  }

  if (!row.refresh_token_enc) {
    await markIntegrationNeedsReauth(userId, provider);
    throw createIntegrationError(provider, "needs_reauth");
  }

  try {
    const refreshToken = decryptToken(row.refresh_token_enc);
    const refresh = await providerClient.refreshAccessToken(refreshToken);
    const nextAccessToken = refresh.accessToken;
    const nextRefreshToken = refresh.refreshToken;

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
        encryptToken(nextAccessToken),
        nextRefreshToken ? encryptToken(nextRefreshToken) : null,
        refresh.expiresAt,
      ],
    );

    return nextAccessToken;
  } catch {
    await markIntegrationNeedsReauth(userId, provider);
    throw createIntegrationError(provider, "needs_reauth");
  }
}

async function fetchRemoteDocument(
  userId: string,
  sourceType: Exclude<DocSourceType, "local">,
  sourceUrl: string,
) {
  const provider = sourceTypeToProvider(sourceType);
  const client = getProviderClient(provider);
  const parsed = client.parseSourceUrl(sourceUrl);
  const accessToken = await getIntegrationAccessToken(userId, sourceType);

  return client.fetchDocument(parsed.sourceUrl, accessToken);
}

function computeDocumentHash(document: {
  kind: DocKind;
  title: string;
  language: string;
  body: string;
}) {
  const payload = [document.kind, document.title, document.language, document.body].join("\n");
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function deriveDocumentName(title: string) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function isValidDocumentName(name: string) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function normalizeDocumentText(rawText: string) {
  return rawText ?? "";
}

function parseDocumentText(rawText: string): ParsedDocumentText {
  const text = normalizeDocumentText(rawText).replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return { name: "", description: "", body: text.trim() };
  }

  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { name: "", description: "", body: text.trim() };
  }

  const frontMatter = match[1];
  const body = match[2].trim();
  const parsed: ParsedDocumentText = { name: "", description: "", body };

  for (const line of frontMatter.split("\n")) {
    const [key, rawValue] = line.split(":", 2);
    if (!key || rawValue === undefined) continue;
    const trimmedKey = key.trim();
    const trimmedValue = rawValue.trim();
    if (trimmedKey === "name") {
      parsed.name = trimmedValue;
    } else if (trimmedKey === "description") {
      parsed.description = trimmedValue;
    }
  }

  return parsed;
}

function buildDocumentText({ name, description, body }: { name: string; description: string; body: string }) {
  const normalizedDescription = description.trim().replace(/\r?\n/g, " ");
  const normalizedBody = body.trim();
  return [
    "---",
    `name: ${name}`,
    `description: ${normalizedDescription}`,
    "---",
    normalizedBody,
  ].join("\n");
}

function normalizeMatrixDocumentCreateBody(body: unknown): MatrixDocumentCreateBody | null {
  if (!body || typeof body !== "object") return null;
  const parsed = body as Partial<MatrixDocumentCreateBodyRemote | MatrixDocumentCreateBodyLocal>;

  const kind = parsed.kind;
  const sourceType = parsed.sourceType === "notion" || parsed.sourceType === "google_doc"
    ? parsed.sourceType
    : "local";

  if (typeof kind !== "string" || !isDocumentKind(kind)) {
    return null;
  }

  const language = typeof parsed.language === "string" ? (parsed.language.trim() || "en") : "en";
  if (!language) return null;

  if (sourceType === "local") {
    const parsedLocal = parsed as Partial<MatrixDocumentCreateBodyLocal>;
    if (
      typeof parsed.title !== "string" ||
      typeof parsedLocal.name !== "string" ||
      typeof parsedLocal.description !== "string"
    ) {
      return null;
    }

    const title = parsed.title.trim();
    const name = parsedLocal.name.trim();
    const description = parsedLocal.description.trim();

    if (!title || !isValidDocumentName(name) || typeof parsedLocal.body !== "string") {
      return null;
    }

    return {
      kind: kind as DocKind,
      sourceType,
      language,
      title,
      name,
      description,
      body: parsedLocal.body,
      attach: parseDocumentAttach(parsed.attach),
    };
  }

  const parsedRemote = parsed as Partial<MatrixDocumentCreateBodyRemote>;
  if (typeof parsedRemote.sourceUrl !== "string") return null;
  const sourceUrl = parsedRemote.sourceUrl.trim();
  if (!sourceUrl) return null;

  const title = typeof parsed.title === "string" ? parsed.title.trim() : undefined;

  return {
    kind: kind as DocKind,
    sourceType,
    language,
    title: title?.length ? title : undefined,
    sourceUrl,
    attach: parseDocumentAttach(parsed.attach),
  };
}

function summarizeSourceUrl(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return sourceUrl.slice(0, 160);
  }
}

function parseConcernList(raw: unknown): string[] | null {
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

function isDocumentKind(value: string): value is DocKind {
  return value === "Document" || value === "Skill" || value === "Prompt";
}

function parseDocumentAttach(
  attach: Partial<MatrixDocumentAttach> | undefined,
): MatrixDocumentAttach | undefined {
  if (!attach) return undefined;
  if (typeof attach !== "object") return undefined;
  const parsedAttach = attach as Partial<{
    nodeId: string;
    concerns: string[];
    concern: string;
    refType: string;
    docHash: string;
  }>;

  if (typeof parsedAttach.nodeId !== "string" || typeof parsedAttach.refType !== "string") {
    return undefined;
  }

  const nodeId = parsedAttach.nodeId.trim();
  const refType = parsedAttach.refType;
  const concern = typeof parsedAttach.concern === "string" ? parsedAttach.concern.trim() : "";
  const concernsFromList = parseConcernList(parsedAttach.concerns);
  const concerns = concernsFromList?.length
    ? concernsFromList
    : concern
      ? [concern]
      : null;

  if (!nodeId || !concerns) return undefined;
  if (!isDocumentKind(refType)) return undefined;

  return {
    nodeId,
    concern: concerns[0],
    concerns,
    refType: refType as DocKind,
    docHash: typeof parsedAttach.docHash === "string" && parsedAttach.docHash.trim() ? parsedAttach.docHash.trim() : undefined,
  };
}

function normalizeMatrixDocumentReplaceBody(body: unknown): MatrixDocumentReplaceBody | null {
  if (!body || typeof body !== "object") return null;
  const parsed = body as Partial<MatrixDocumentReplaceBody>;
  const hasAny =
    typeof parsed.title !== "undefined" ||
    typeof parsed.name !== "undefined" ||
    typeof parsed.description !== "undefined" ||
    typeof parsed.language !== "undefined" ||
    typeof parsed.body !== "undefined";

  if (!hasAny) return null;

  const normalized: MatrixDocumentReplaceBody = {};
  if (typeof parsed.title !== "undefined") {
    if (typeof parsed.title !== "string") return null;
    const title = parsed.title.trim();
    if (!title) return null;
    normalized.title = title;
  }
  if (typeof parsed.name !== "undefined") {
    if (typeof parsed.name !== "string" || !isValidDocumentName(parsed.name.trim())) return null;
    normalized.name = parsed.name.trim();
  }
  if (typeof parsed.description !== "undefined") {
    if (typeof parsed.description !== "string") return null;
    normalized.description = parsed.description.trim();
  }
  if (typeof parsed.language !== "undefined") {
    if (typeof parsed.language !== "string" || !parsed.language.trim()) return null;
    normalized.language = parsed.language.trim();
  }
  if (typeof parsed.body !== "undefined") {
    if (typeof parsed.body !== "string") return null;
    normalized.body = parsed.body;
  }

  return normalized;
}

async function resolveThreadContext(
  userId: string | null,
  handle: string,
  projectName: string,
  projectThreadId: number,
): Promise<ThreadContext | null> {
  const result = await query<ThreadContextRow>(
    `SELECT
     t.id AS thread_id,
     t.project_thread_id,
     p.id AS project_id,
     t.title,
     t.description,
     t.status,
     t.created_at,
     creator.handle AS created_by_handle,
     p.name AS project_name,
     owner.handle AS owner_handle,
     CASE
       WHEN CAST($1 AS uuid) IS NOT NULL AND p.owner_id = CAST($1 AS uuid) THEN 'Owner'
       WHEN pc.role IS NOT NULL THEN pc.role::text
       WHEN p.visibility = 'public' THEN 'Viewer'
       ELSE NULL
     END AS access_role
   FROM projects p
   JOIN users owner ON owner.id = p.owner_id
   JOIN threads t ON t.project_id = p.id
   JOIN users creator ON creator.id = t.created_by
   LEFT JOIN project_collaborators pc
     ON pc.project_id = p.id
    AND pc.user_id = CAST($1 AS uuid)
   WHERE owner.handle = $2
     AND p.name = $3
     AND t.project_thread_id = $4
   LIMIT 1`,
    [userId, handle, projectName, projectThreadId],
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  if (!row.access_role) return null;
  return {
    threadId: row.thread_id,
    projectThreadId: row.project_thread_id,
    projectId: row.project_id,
    title: row.title ?? "Untitled",
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    createdByHandle: row.created_by_handle,
    projectName: row.project_name,
    ownerHandle: row.owner_handle,
    accessRole: row.access_role,
  };
}

function buildThreadPayload(context: ThreadContext) {
  return {
    id: context.threadId,
    projectThreadId: context.projectThreadId,
    title: context.title,
    description: context.description,
    status: context.status,
    createdAt: context.createdAt,
    createdByHandle: context.createdByHandle,
    ownerHandle: context.ownerHandle,
    projectName: context.projectName,
    accessRole: context.accessRole,
  };
}

interface ThreadDetailPayload {
  systemId: string;
  thread: ReturnType<typeof buildThreadPayload>;
  permissions: {
    canEdit: boolean;
    canChat: boolean;
  };
  topology: {
    nodes: Array<{
      id: string;
      name: string;
      kind: string;
      parentId: string | null;
      layoutX: number | null;
      layoutY: number | null;
      ownership: "first_party" | "third_party";
      boundary: "internal" | "external";
    }>;
    edges: Array<{
      id: string;
      type: string;
      fromNodeId: string;
      toNodeId: string;
      protocol: string | null;
      layer7: string | null;
    }>;
  };
  systemPrompt: string | null;
  systemPromptTitle: string | null;
  systemPrompts: SystemPromptRow[];
  matrix: {
    concerns: Array<{
      name: string;
      position: number;
    }>;
    nodes: Array<{
      id: string;
      name: string;
      kind: string;
      parentId: string | null;
      layoutX: number | null;
      layoutY: number | null;
      ownership: "first_party" | "third_party";
      boundary: "internal" | "external";
    }>;
    cells: MatrixCell[];
  documents: Array<{
      hash: string;
      kind: "Document" | "Skill" | "Prompt";
      title: string;
      language: string;
      text: string;
      sourceType: DocSourceType;
      sourceUrl: string | null;
      sourceExternalId: string | null;
      sourceMetadata: Record<string, unknown> | null;
      sourceConnectedUserId: string | null;
    }>;
  };
  chat: {
    messages: ThreadChatMessage[];
  };
}

interface RawOpenShipBundleFilePayload {
  path?: unknown;
  content?: unknown;
}

function parseOpenShipBundleFiles(value: unknown): OpenShipBundleFile[] | null {
  if (value === undefined) return [];

  if (!Array.isArray(value)) return null;

  const files: OpenShipBundleFile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;

    const candidate = entry as RawOpenShipBundleFilePayload;
    if (typeof candidate.path !== "string" || typeof candidate.content !== "string") return null;

    files.push({
      path: candidate.path,
      content: candidate.content,
    });
  }

  return files;
}

function canEdit(accessRole: string) {
  return EDIT_ROLES.has(accessRole);
}

function matrixCellKey(nodeId: string, concern: string) {
  return `${nodeId}::${concern}`;
}

function normalizeMatrixMutationBody(
  body: unknown,
): { nodeId: string; concerns: string[]; concern: string; docHash: string; refType: DocKind } | null {
  if (!body || typeof body !== "object") return null;
  const parsed = body as Partial<MatrixRefBody>;

  if (
    typeof parsed.nodeId !== "string" ||
    typeof parsed.docHash !== "string" ||
    typeof parsed.refType !== "string"
  ) {
    return null;
  }

  const nodeId = parsed.nodeId.trim();
  const docHash = parsed.docHash.trim();
  const refType = parsed.refType;
  const concern = typeof parsed.concern === "string" ? parsed.concern.trim() : "";
  const concernsFromList = parseConcernList(parsed.concerns);
  const concerns = concernsFromList?.length
    ? concernsFromList
    : concern
      ? [concern]
      : null;

  if (!nodeId || !concerns || !docHash) return null;
  if (!isDocumentKind(refType)) return null;

  return { nodeId, concern: concerns[0], concerns, docHash, refType };
}

function normalizeTopologyLayoutBody(
  body: unknown,
): { positions: Array<{ nodeId: string; x: number; y: number }> } | null {
  if (!body || typeof body !== "object") return null;
  const parsed = body as Partial<TopologyLayoutBody>;
  if (!Array.isArray(parsed.positions) || parsed.positions.length === 0) return null;

  const seen = new Set<string>();
  const positions: Array<{ nodeId: string; x: number; y: number }> = [];
  for (const position of parsed.positions) {
    if (!position || typeof position !== "object") return null;
    const entry = position as Partial<TopologyLayoutBody["positions"][number]>;
    if (typeof entry.nodeId !== "string" || typeof entry.x !== "number" || typeof entry.y !== "number") {
      return null;
    }

    const nodeId = entry.nodeId.trim();
    if (!nodeId) return null;
    if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return null;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);

    positions.push({ nodeId, x: entry.x, y: entry.y });
  }

  if (positions.length === 0) return null;
  return { positions };
}

async function getSystemRootNodeId(
  systemId: string,
  client?: PoolClient,
): Promise<string | null> {
  const result = await (client
    ? client.query<SystemRootNodeRow>(`SELECT root_node_id FROM systems WHERE id = $1`, [systemId])
    : query<SystemRootNodeRow>(`SELECT root_node_id FROM systems WHERE id = $1`, [systemId]));
  return result.rows[0]?.root_node_id ?? null;
}

async function ensureSystemPromptConcern(systemId: string, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO concerns (system_id, name, position, is_baseline, scope)
     VALUES (
      $1,
      $2,
      COALESCE((SELECT MAX(position) FROM concerns WHERE system_id = $1), -1) + 1,
      false,
      'system'
     )
     ON CONFLICT DO NOTHING`,
    [systemId, SYSTEM_PROMPT_CONCERN],
  );
}

interface SystemPromptAttachmentPayload {
  nodeId: string;
  concern: string;
  concerns: string[];
  refType: "Prompt";
  docHash: string;
}

interface SystemPromptValidationFailure {
  valid: false;
  error: string;
}

interface SystemPromptValidationSuccess {
  valid: true;
  payload: SystemPromptAttachmentPayload;
}

type SystemPromptValidationResult = SystemPromptValidationSuccess | SystemPromptValidationFailure;

async function validateSystemPromptAttachment(
  client: PoolClient,
  systemId: string,
  attachment: SystemPromptAttachmentPayload,
): Promise<SystemPromptValidationResult> {
  const rootNodeId = await getSystemRootNodeId(systemId, client);
  if (!rootNodeId) {
    return { valid: false, error: "Unable to resolve system root node" };
  }

  if (attachment.concerns.length !== 1) {
    return { valid: false, error: "System prompts require exactly one concern" };
  }

  const concern = attachment.concerns[0];
  if (concern !== SYSTEM_PROMPT_CONCERN) {
    return { valid: false, error: `System prompts require concern "${SYSTEM_PROMPT_CONCERN}"` };
  }

  if (attachment.nodeId !== rootNodeId) {
    return { valid: false, error: "System prompts can only be attached to the system root node" };
  }

  await ensureSystemPromptConcern(systemId, client);

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

async function getSystemPromptsForSystem(
  systemId: string,
  client?: PoolClient,
): Promise<SystemPromptRow[]> {
  const result = await (client
    ? client.query<SystemPromptRow>(
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
    )
    : query<SystemPromptRow>(
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
    ));
  const deduped = new Map<string, SystemPromptRow>();
  for (const row of result.rows) {
    if (deduped.has(row.hash)) continue;
    deduped.set(row.hash, row);
  }
  return Array.from(deduped.values());
}

async function getSystemPromptWithMetadataForSystem(
  systemId: string,
  client?: PoolClient,
): Promise<{ text: string | null; title: string | null; systemPrompts: SystemPromptRow[] }> {
  const prompts = await getSystemPromptsForSystem(systemId, client);
  const latest = prompts[0];
  return {
    text: latest?.text ?? null,
    title: latest?.title ?? null,
    systemPrompts: prompts,
  };
}

async function getThreadSystemId(threadId: string): Promise<string | null> {
  const result = await query<SystemRow>(
    "SELECT thread_current_system($1) AS system_id",
    [threadId],
  );
  return result.rows[0]?.system_id ?? null;
}

async function buildThreadStatePayload(context: ThreadContext): Promise<ThreadDetailPayload> {
  const systemId = await getThreadSystemId(context.threadId);
  if (!systemId) {
    throw new Error("Unable to resolve thread system");
  }

  const [nodesResult, edgesResult, concernsResult, matrixRefsResult, documentsResult, artifactsResult, messagesResult, systemPromptMetadataResult] =
    await Promise.all([
      query<TopologyNodeRow>(
        `SELECT
           id,
           name,
           kind,
           parent_id,
           (metadata->'layout'->>'x')::double precision AS layout_x,
           (metadata->'layout'->>'y')::double precision AS layout_y,
           metadata->>'ownership' AS ownership,
           metadata->>'boundary' AS boundary
         FROM nodes
         WHERE system_id = $1
         ORDER BY name, id`,
        [systemId],
      ),
      query<TopologyEdgeRow>(
        `SELECT id, type, from_node_id, to_node_id, metadata->>'protocol' AS protocol, metadata->>'layer7' AS layer7
         FROM edges
         WHERE system_id = $1
         ORDER BY id`,
        [systemId],
      ),
      query<ConcernRow>(
        `SELECT name, position
         FROM concerns
         WHERE system_id = $1
           AND scope IS DISTINCT FROM 'system'
           AND name <> $2
         ORDER BY position, name`,
        [systemId, SYSTEM_PROMPT_CONCERN],
      ),
      query<MatrixRefRow>(
        `SELECT
           mr.node_id,
           mr.concern,
           mr.doc_hash,
           mr.ref_type,
           d.title AS doc_title,
           d.kind AS doc_kind,
           d.language AS doc_language,
           d.source_type AS doc_source_type,
           d.source_url AS doc_source_url,
           d.source_external_id AS doc_source_external_id,
           d.source_metadata AS doc_source_metadata,
           d.source_connected_user_id AS doc_source_connected_user_id
         FROM matrix_refs mr
         JOIN documents d ON d.system_id = mr.system_id AND d.hash = mr.doc_hash
         WHERE mr.system_id = $1
           AND mr.ref_type IN ('Document'::ref_type, 'Skill'::ref_type)
         ORDER BY mr.node_id, mr.concern, mr.ref_type, d.title`,
        [systemId],
      ),
      query<MatrixDocumentRow>(
        `SELECT hash, kind, title, language, text, source_type, source_url, source_external_id, source_metadata, source_connected_user_id
         FROM documents
         WHERE system_id = $1
           AND kind IN ('Document'::doc_kind, 'Skill'::doc_kind)
         ORDER BY kind, title, hash`,
        [systemId],
      ),
      query<ArtifactRow>(
        `SELECT id, node_id, concern, type, language, text
         FROM artifacts
         WHERE system_id = $1
         ORDER BY node_id, concern, created_at, id`,
        [systemId],
      ),
      query<ChatMessageRow>(
        `SELECT m.id, m.action_id, m.role, m.content, m.created_at, a.position AS action_position, a.type AS action_type
         FROM messages m
         JOIN actions a ON a.thread_id = m.thread_id AND a.id = m.action_id
         WHERE m.thread_id = $1
         ORDER BY a.position, m.position`,
        [context.threadId],
      ),
      getSystemPromptWithMetadataForSystem(systemId),
    ]);

  const nodes = nodesResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parent_id,
    layoutX: row.layout_x,
    layoutY: row.layout_y,
    ownership: normalizeNodeOwnership(row.ownership),
    boundary: normalizeNodeBoundary(row.boundary),
  }));

  const concerns = concernsResult.rows.map((row) => ({
    name: row.name,
    position: row.position,
  }));

  const cellsByKey = new Map<string, MatrixCell>();
  for (const node of nodes) {
    for (const concern of concerns) {
      const key = matrixCellKey(node.id, concern.name);
      cellsByKey.set(key, {
        nodeId: node.id,
        concern: concern.name,
        docs: [],
        artifacts: [],
      });
    }
  }

  for (const row of matrixRefsResult.rows) {
    const key = matrixCellKey(row.node_id, row.concern);
    const existing = cellsByKey.get(key) ?? {
      nodeId: row.node_id,
      concern: row.concern,
      docs: [],
      artifacts: [],
    };
    existing.docs.push({
      hash: row.doc_hash,
      title: row.doc_title,
      kind: row.doc_kind,
      language: row.doc_language,
      sourceType: row.doc_source_type,
      sourceUrl: row.doc_source_url,
      sourceExternalId: row.doc_source_external_id,
      sourceMetadata: row.doc_source_metadata,
      sourceConnectedUserId: row.doc_source_connected_user_id,
      refType: row.ref_type,
    });
    cellsByKey.set(key, existing);
  }

  for (const row of artifactsResult.rows) {
    const key = matrixCellKey(row.node_id, row.concern);
    const existing = cellsByKey.get(key) ?? {
      nodeId: row.node_id,
      concern: row.concern,
      docs: [],
      artifacts: [],
    };
    existing.artifacts.push({
      id: row.id,
      type: row.type,
      language: row.language,
      text: row.text,
    });
    cellsByKey.set(key, existing);
  }

  return {
    systemId,
    thread: buildThreadPayload(context),
    permissions: {
      canEdit: canEdit(context.accessRole),
      canChat: canEdit(context.accessRole),
    },
    topology: {
      nodes,
      edges: edgesResult.rows.map((row) => ({
        id: row.id,
        type: row.type,
        fromNodeId: row.from_node_id,
        toNodeId: row.to_node_id,
        protocol: row.protocol,
        layer7: row.layer7,
      })),
    },
    matrix: {
      concerns,
      nodes,
      cells: Array.from(cellsByKey.values()),
      documents: documentsResult.rows.map((row) => ({
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
      })),
    },
    systemPrompt: systemPromptMetadataResult.text,
    systemPromptTitle: systemPromptMetadataResult.title,
    systemPrompts: systemPromptMetadataResult.systemPrompts,
    chat: {
      messages: mapChatMessages(messagesResult.rows),
    },
  };
}

async function getMatrixCell(systemId: string, nodeId: string, concern: string): Promise<MatrixCell> {
  const [docsResult, artifactsResult] = await Promise.all([
    query<MatrixRefRow>(
      `SELECT
         mr.node_id,
         mr.concern,
         mr.doc_hash,
         mr.ref_type,
         d.title AS doc_title,
         d.kind AS doc_kind,
         d.language AS doc_language
         , d.source_type AS doc_source_type,
         d.source_url AS doc_source_url,
         d.source_external_id AS doc_source_external_id,
         d.source_metadata AS doc_source_metadata,
         d.source_connected_user_id AS doc_source_connected_user_id
       FROM matrix_refs mr
       JOIN documents d ON d.system_id = mr.system_id AND d.hash = mr.doc_hash
       WHERE mr.system_id = $1
         AND mr.node_id = $2
         AND mr.concern_hash = md5($3)
         AND mr.concern = $3
         AND mr.ref_type IN ('Document'::ref_type, 'Skill'::ref_type)
       ORDER BY mr.ref_type, d.title`,
      [systemId, nodeId, concern],
    ),
    query<ArtifactRow>(
      `SELECT id, node_id, concern, type, language, text
       FROM artifacts
       WHERE system_id = $1 AND node_id = $2 AND concern = $3
       ORDER BY created_at, id`,
      [systemId, nodeId, concern],
    ),
  ]);

  return {
    nodeId,
    concern,
    docs: docsResult.rows.map((row) => ({
      hash: row.doc_hash,
      title: row.doc_title,
      kind: row.doc_kind,
      language: row.doc_language,
      sourceType: row.doc_source_type,
      sourceUrl: row.doc_source_url,
      sourceExternalId: row.doc_source_external_id,
      sourceMetadata: row.doc_source_metadata,
      sourceConnectedUserId: row.doc_source_connected_user_id,
      refType: row.ref_type,
    })),
    artifacts: artifactsResult.rows.map((row) => ({
      id: row.id,
      type: row.type,
      language: row.language,
      text: row.text,
    })),
  };
}

async function getMatrixCells(systemId: string, nodeId: string, concerns: string[]): Promise<MatrixCell[]> {
  if (concerns.length === 0) return [];
  const normalizedConcerns = Array.from(new Set(concerns.map((concern) => concern.trim()).filter(Boolean)));
  if (normalizedConcerns.length === 0) return [];

  const cells = await Promise.all(
    normalizedConcerns.map((concern) => getMatrixCell(systemId, nodeId, concern)),
  );

  const byConcern = new Map<string, MatrixCell>();
  for (const cell of cells) {
    byConcern.set(cell.concern, cell);
  }
  return normalizedConcerns.map((concern) => byConcern.get(concern)).filter(Boolean) as MatrixCell[];
}

async function requireContext(
  reply: FastifyReply,
  userId: string | null,
  handle: string,
  projectName: string,
  threadId: string,
): Promise<ThreadContext | null> {
  const parsedThreadId = parseThreadId(threadId);
  if (!parsedThreadId) {
    await reply.code(400).send({ error: "Invalid thread id" });
    return null;
  }

  const context = await resolveThreadContext(userId, handle, projectName, parsedThreadId);
  if (!context) {
    await reply.code(404).send({ error: "Thread not found" });
    return null;
  }

  return context;
}

export async function threadRoutes(app: FastifyInstance) {
  app.addHook("preHandler", verifyOptionalAuth);

  app.get<{ Params: { handle: string; projectName: string; threadId: string } }>(
    "/projects/:handle/:projectName/thread/:threadId",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      return buildThreadStatePayload(context);
    },
  );

  app.patch<{ Params: { handle: string; projectName: string; threadId: string }; Body: ThreadPatchBody }>(
    "/projects/:handle/:projectName/thread/:threadId",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const { title, description } = req.body ?? {};
      if (typeof title === "undefined" && typeof description === "undefined") {
        return reply.code(400).send({ error: "No fields to update" });
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (typeof title !== "undefined") {
        if (typeof title !== "string" || !title.trim()) {
          return reply.code(400).send({ error: "title cannot be blank" });
        }
        values.push(title.trim());
        updates.push(`title = $${values.length}`);
      }

      if (typeof description !== "undefined") {
        if (description !== null && typeof description !== "string") {
          return reply.code(400).send({ error: "description must be a string or null" });
        }
        const normalizedDescription = description === null ? null : (description.trim() || null);
        values.push(normalizedDescription);
        updates.push(`description = $${values.length}`);
      }

      values.push(context.threadId);

      const result = await query<UpsertThreadRow>(
        `UPDATE threads
         SET ${updates.join(", ")}
         WHERE id = $${values.length}
         RETURNING id, project_thread_id, title, description, status`,
        values,
      );

      if (result.rowCount === 0) {
        return reply.code(404).send({ error: "Thread not found" });
      }

      const updated = result.rows[0];
      return {
        thread: {
          id: updated.id,
          projectThreadId: updated.project_thread_id,
          title: updated.title,
          description: updated.description,
          status: updated.status,
          createdAt: context.createdAt,
          createdByHandle: context.createdByHandle,
          ownerHandle: context.ownerHandle,
          projectName: context.projectName,
          accessRole: context.accessRole,
        },
      };
    },
  );

  app.post<{ Params: { handle: string; projectName: string; threadId: string } }>(
    "/projects/:handle/:projectName/thread/:threadId/close",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      if (context.status !== "open") {
        return reply.code(409).send({ error: "Thread is already closed" });
      }

      await query("SELECT close_thread($1)", [context.threadId]);

      const result = await query<UpsertThreadRow>(
        `SELECT id, project_thread_id, title, description, status
         FROM threads WHERE id = $1`,
        [context.threadId],
      );

      const updated = result.rows[0];
      return {
        thread: {
          id: updated.id,
          projectThreadId: updated.project_thread_id,
          title: updated.title,
          description: updated.description,
          status: updated.status,
          createdAt: context.createdAt,
          createdByHandle: context.createdByHandle,
          ownerHandle: context.ownerHandle,
          projectName: context.projectName,
          accessRole: context.accessRole,
        },
      };
    },
  );

  app.post<{ Params: { handle: string; projectName: string; threadId: string } }>(
    "/projects/:handle/:projectName/thread/:threadId/commit",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      if (context.status !== "open") {
        return reply.code(409).send({ error: "Thread is already committed" });
      }

      await query("SELECT commit_thread($1)", [context.threadId]);

      const result = await query<UpsertThreadRow>(
        `SELECT id, project_thread_id, title, description, status
         FROM threads WHERE id = $1`,
        [context.threadId],
      );

      const updated = result.rows[0];
      return {
        thread: {
          id: updated.id,
          projectThreadId: updated.project_thread_id,
          title: updated.title,
          description: updated.description,
          status: updated.status,
          createdAt: context.createdAt,
          createdByHandle: context.createdByHandle,
          ownerHandle: context.ownerHandle,
          projectName: context.projectName,
          accessRole: context.accessRole,
        },
      };
    },
  );

  app.post<{
    Params: { handle: string; projectName: string; threadId: string };
    Body: CloneThreadBody;
  }>(
    "/projects/:handle/:projectName/thread/:threadId/clone",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      if (!isFinalizedThreadStatus(context.status)) {
        return reply.code(409).send({ error: "Thread is not finalized" });
      }
      const actorUserId = getViewerUserId(req);
      if (!actorUserId) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const hasRequestedDescription = typeof req.body?.description === "string";
      const requestedTitle = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      const requestedDescription = hasRequestedDescription ? (req.body.description as string).trim() : "";
      const clonedTitle = requestedTitle || `${context.title ?? "Untitled"} (Clone)`;
      const clonedDescription = hasRequestedDescription ? (requestedDescription || null) : (context.description || null);
      const clonedThreadId = randomUUID();

      await query("SELECT clone_thread($1, $2, $3, $4, $5, $6)", [
        clonedThreadId,
        context.threadId,
        context.projectId,
        actorUserId,
        clonedTitle,
        clonedDescription,
      ]);

      const clonedResult = await query<ClonedThreadRow>(
        `SELECT
           t.id AS thread_id,
           t.project_thread_id,
           t.title,
           t.description,
           t.status,
           t.created_at,
           creator.handle AS created_by_handle,
           p.name AS project_name,
           owner.handle AS owner_handle
         FROM threads t
         JOIN users creator ON creator.id = t.created_by
         JOIN projects p ON p.id = t.project_id
         JOIN users owner ON owner.id = p.owner_id
         WHERE t.id = $1`,
        [clonedThreadId],
      );

      if (clonedResult.rowCount === 0) {
        return reply.code(404).send({ error: "Cloned thread not found" });
      }

      const cloned = clonedResult.rows[0];
      return {
        thread: {
          id: cloned.thread_id,
          projectThreadId: cloned.project_thread_id,
          title: cloned.title,
          description: cloned.description,
          status: cloned.status,
          createdAt: cloned.created_at,
          createdByHandle: cloned.created_by_handle,
          ownerHandle: cloned.owner_handle,
          projectName: cloned.project_name,
          accessRole: context.accessRole,
        },
      };
    },
  );

  app.patch<{ Params: { handle: string; projectName: string; threadId: string }; Body: TopologyLayoutBody }>(
    "/projects/:handle/:projectName/thread/:threadId/topology/layout",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const payload = normalizeTopologyLayoutBody(req.body);
      if (!payload) {
        return reply.code(400).send({ error: "Invalid topology layout payload" });
      }

      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("BEGIN");
        inTransaction = true;

        const actionId = randomUUID();
        const beginResult = await client.query<BeginActionRow>(
          `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
          [context.threadId, actionId, "Edit", "Topology layout update"],
        );

        const outputSystemId = beginResult.rows[0]?.output_system_id;
        if (!outputSystemId) {
          throw new Error("Failed to create action output system");
        }

        const requestedNodeIds = payload.positions.map((position) => position.nodeId);
        const existingNodesResult = await client.query<{ id: string }>(
          `SELECT id
           FROM nodes
           WHERE system_id = $1
             AND id = ANY($2::text[])`,
          [outputSystemId, requestedNodeIds],
        );

        const existingNodeIds = new Set(existingNodesResult.rows.map((row) => row.id));
        const invalidNode = requestedNodeIds.find((nodeId) => !existingNodeIds.has(nodeId));
        if (invalidNode) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return reply.code(400).send({ error: "Invalid node id in topology layout payload" });
        }

        let changedCount = 0;
        for (const position of payload.positions) {
          const updateResult = await client.query<ChangedRow>(
            `UPDATE nodes
             SET metadata = jsonb_set(
               coalesce(metadata, '{}'::jsonb),
               '{layout}',
               jsonb_build_object('x', $3, 'y', $4),
               true
             )
             WHERE system_id = $1
               AND id = $2
               AND (
                 (metadata->'layout'->>'x')::double precision IS DISTINCT FROM $3
                 OR (metadata->'layout'->>'y')::double precision IS DISTINCT FROM $4
               )
             RETURNING 1 AS changed`,
            [outputSystemId, position.nodeId, position.x, position.y],
          );
          changedCount += updateResult.rowCount ?? 0;
        }

        if (changedCount === 0) {
          await client.query("SELECT commit_action_empty($1, $2)", [context.threadId, actionId]);
        }

        await client.query("COMMIT");
        inTransaction = false;
      } catch (error) {
        if (inTransaction) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Best effort rollback.
          }
        }
        throw error;
      } finally {
        client.release();
      }

      const systemId = await getThreadSystemId(context.threadId);
      if (!systemId) {
        return reply.code(500).send({ error: "Unable to resolve thread system" });
      }

      return { systemId };
    },
  );

  app.post<{ Params: { handle: string; projectName: string; threadId: string }; Body: MatrixRefBody }>(
    "/projects/:handle/:projectName/thread/:threadId/matrix/refs",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      let payload = normalizeMatrixMutationBody(req.body);
      if (!payload) {
        return reply.code(400).send({ error: "Invalid matrix reference payload" });
      }

      const client = await pool.connect();
      let inTransaction = false;
      let actionMessages: ThreadChatMessage[] = [];
      let concerns = payload.concerns;

      try {
        await client.query("BEGIN");
        inTransaction = true;

        const actionId = randomUUID();
        const beginResult = await client.query<BeginActionRow>(
          `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
          [context.threadId, actionId, "Edit", "Matrix doc add"],
        );

        const outputSystemId = beginResult.rows[0]?.output_system_id;
      if (!outputSystemId) {
        throw new Error("Failed to create action output system");
      }

      if (payload.refType === "Prompt") {
        const validation = await validateSystemPromptAttachment(
          client,
          outputSystemId,
          {
            nodeId: payload.nodeId,
            concern: payload.concern,
            concerns: payload.concerns,
            refType: "Prompt",
            docHash: payload.docHash,
          },
        );
          if (!validation.valid) {
            await client.query("ROLLBACK");
            inTransaction = false;
            return reply.code(400).send({ error: validation.error });
          }
          payload = validation.payload;
          concerns = validation.payload.concerns;
        }

        let changed = 0;
        for (const concern of concerns) {
          const insertResult = await client.query<ChangedRow>(
            `INSERT INTO matrix_refs (system_id, node_id, concern, ref_type, doc_hash)
             VALUES ($1, $2, $3, $4::ref_type, $5)
             ON CONFLICT DO NOTHING
             RETURNING 1 AS changed`,
            [outputSystemId, payload.nodeId, concern, payload.refType, payload.docHash],
          );
          changed += insertResult.rowCount ?? 0;
        }

        if (changed === 0) {
          await client.query("SELECT commit_action_empty($1, $2)", [context.threadId, actionId]);
        } else {
          const title = await getDocumentTitleByHash(client, outputSystemId, payload.docHash) ?? payload.docHash;
          const nodeName = await getNodeNameById(client, outputSystemId, payload.nodeId);
          await insertSystemActionMessage(
            client,
            context.threadId,
            actionId,
            buildDocumentAddSummary(title, nodeName),
          );
          actionMessages = await getActionMessages(client, context.threadId, actionId);
        }

        await client.query("COMMIT");
        inTransaction = false;
      } catch (error: unknown) {
        if (inTransaction) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Best effort rollback.
          }
        }

        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code?: string }).code === "23503"
        ) {
          return reply.code(400).send({ error: "Invalid node, concern, or document reference" });
        }

        throw error;
      } finally {
        client.release();
      }

      const systemId = await getThreadSystemId(context.threadId);
      if (!systemId) {
        return reply.code(500).send({ error: "Unable to resolve thread system" });
      }
      const cells = await getMatrixCells(systemId, payload.nodeId, concerns);
      const systemPrompt = payload.refType === "Prompt"
        ? await getSystemPromptWithMetadataForSystem(systemId)
        : undefined;

      if (cells.length === 1) {
        return systemPrompt === undefined
          ? { systemId, cell: cells[0], cells, messages: actionMessages }
          : {
            systemId,
            cell: cells[0],
            cells,
            systemPrompt: systemPrompt.text,
            systemPromptTitle: systemPrompt.title,
            systemPrompts: systemPrompt.systemPrompts,
            messages: actionMessages,
          };
      }
      return systemPrompt === undefined
        ? { systemId, cells, messages: actionMessages }
        : {
          systemId,
          cells,
          systemPrompt: systemPrompt.text,
          systemPromptTitle: systemPrompt.title,
          systemPrompts: systemPrompt.systemPrompts,
          messages: actionMessages,
        };
    },
  );

  app.post<{ Params: { handle: string; projectName: string; threadId: string }; Body: MatrixDocumentCreateBody }>(
    "/projects/:handle/:projectName/thread/:threadId/matrix/documents",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const actorUserId = getViewerUserId(req);
      if (!actorUserId) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      let payload = normalizeMatrixDocumentCreateBody(req.body);
      if (!payload) {
        req.log.warn({
          threadId: context.threadId,
          body: req.body,
        }, "Invalid matrix document payload");
        return reply.code(400).send({ error: "Invalid matrix document payload" });
      }
      if (payload.kind === "Prompt" && !payload.attach) {
        return reply.code(400).send({ error: "System prompts require an attach payload." });
      }
      if (payload.kind === "Prompt" && payload.sourceType !== "local") {
        return reply.code(400).send({ error: "System prompts must be local documents." });
      }

      let sourceUrl: string | null = null;
      let sourceExternalId: string | null = null;
      let sourceMetadata: Record<string, unknown> | null = null;
      let sourceTitle = payload.title;
      let text: string;
      let sourceConnectedUserId: string | null = null;

      if (payload.sourceType !== "local") {
        try {
          const remote = await fetchRemoteDocument(actorUserId, payload.sourceType, payload.sourceUrl);
          sourceUrl = remote.sourceUrl;
          sourceExternalId = remote.sourceExternalId;
          sourceMetadata = remote.sourceMetadata;
          sourceTitle = remote.title;
          text = remote.text;
          sourceConnectedUserId = actorUserId;
        } catch (error) {
          if (isIntegrationMissingError(error)) {
            req.log.warn({
              threadId: context.threadId,
              provider: error.provider,
              status: error.status,
              sourceType: payload.sourceType,
              sourceUrl: summarizeSourceUrl(payload.sourceUrl),
            }, "Matrix document import blocked by integration state");
            return reply.code(409).send({
              error: "Integration required",
              provider: error.provider,
              status: error.status,
              code: error.code,
            });
          }
          if (isNotionApiError(error)) {
            req.log.warn({
              threadId: context.threadId,
              sourceType: payload.sourceType,
              sourceUrl: summarizeSourceUrl(payload.sourceUrl),
              status: error.status,
              statusText: error.statusText,
              reason: error.reason,
              requestUrl: error.requestUrl,
              responseBody: error.responseBody,
            }, "Notion document import failed");
            return reply.code(error.status >= 500 ? 502 : 400).send({
              error: error.reason,
              provider: error.provider,
              status: error.status,
              code: error.code,
            });
          }
          req.log.error(
            {
              threadId: context.threadId,
              sourceType: payload.sourceType,
              err: error,
            },
            "Matrix document import failed",
          );
          throw error;
        }
      } else {
        text = buildDocumentText({
          name: payload.name,
          description: payload.description,
          body: payload.body,
        });
      }

      const title = sourceTitle ?? "Imported document";
      const hash = computeDocumentHash({
        kind: payload.kind,
        title,
        language: payload.language,
        body: text,
      });

      const client = await pool.connect();
      let inTransaction = false;
      let actionMessages: ThreadChatMessage[] = [];

      try {
        await client.query("BEGIN");
        inTransaction = true;

        const actionId = randomUUID();
        const actionLabel = payload.sourceType !== "local" ? "Matrix doc import" : "Matrix doc create";
        const actionType = payload.sourceType !== "local" ? "Import" : "Edit";
        const beginResult = await client.query<BeginActionRow>(
          `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
          [context.threadId, actionId, actionType, actionLabel],
        );
        const outputSystemId = beginResult.rows[0]?.output_system_id;
        if (!outputSystemId) {
          throw new Error("Failed to create action output system");
        }

        if (payload.kind === "Prompt") {
          if (payload.sourceType !== "local") {
            await client.query("ROLLBACK");
            inTransaction = false;
            return reply.code(400).send({ error: "System prompts must be local documents." });
          }
          if (!payload.attach) {
            await client.query("ROLLBACK");
            inTransaction = false;
            return reply.code(400).send({ error: "System prompts require an attach payload." });
          }
          const validation = await validateSystemPromptAttachment(
            client,
            outputSystemId,
            {
              nodeId: payload.attach.nodeId,
              concern: payload.attach.concern,
              concerns: payload.attach.concerns,
              refType: "Prompt",
              docHash: payload.attach.docHash ?? hash,
            },
          );
          if (!validation.valid) {
            await client.query("ROLLBACK");
            inTransaction = false;
            return reply.code(400).send({ error: validation.error });
          }
          payload = {
            ...payload,
            attach: validation.payload,
          };
        }

        const insertResult = await client.query<MatrixDocumentRow>(
          `INSERT INTO documents (
             hash,
             system_id,
             kind,
             title,
             language,
             text,
             source_type,
             source_url,
             source_external_id,
             source_metadata,
             source_connected_user_id
           )
           VALUES ($1, $2, $3::doc_kind, $4, $5, $6, $7::doc_source_type, $8, $9, $10, $11)
           ON CONFLICT (system_id, hash) DO NOTHING
           RETURNING hash, kind, title, language, text, source_type, source_url, source_external_id, source_metadata, source_connected_user_id`,
          [
            hash,
            outputSystemId,
            payload.kind,
            title,
            payload.language,
            text,
            payload.sourceType,
            sourceUrl,
            sourceExternalId,
            sourceMetadata,
            sourceConnectedUserId,
          ],
        );

        const shouldAttach = Boolean(payload.attach);
        let insertRefCount = 0;
        if (payload.attach) {
          for (const concern of payload.attach.concerns) {
            const insertRefResult = await client.query<ChangedRow>(
              `INSERT INTO matrix_refs (system_id, node_id, concern, ref_type, doc_hash)
               VALUES ($1, $2, $3, $4::ref_type, $5)
               ON CONFLICT DO NOTHING
               RETURNING 1 AS changed`,
              [outputSystemId, payload.attach.nodeId, concern, payload.attach.refType, hash],
            );
            insertRefCount += insertRefResult.rowCount ?? 0;
          }
        }

        const createdOrImported = (insertResult.rowCount ?? 0) > 0;
        const changed = createdOrImported || insertRefCount > 0;
        if (!changed) {
          await client.query("SELECT commit_action_empty($1, $2)", [context.threadId, actionId]);
        } else {
          const nodeName = payload.attach
            ? await getNodeNameById(client, outputSystemId, payload.attach.nodeId)
            : null;
          await insertSystemActionMessage(
            client,
            context.threadId,
            actionId,
            buildDocumentCreateSummary(title, payload.sourceType, nodeName, insertRefCount > 0),
          );
          actionMessages = await getActionMessages(client, context.threadId, actionId);
        }

        await client.query("COMMIT");
        inTransaction = false;

        const systemId = await getThreadSystemId(context.threadId);
        if (!systemId) {
          return reply.code(500).send({ error: "Unable to resolve thread system" });
        }

        const nextDocument = insertResult.rows[0] ?? {
          hash,
          kind: payload.kind,
          title,
          language: payload.language,
          text,
          sourceType: payload.sourceType,
          sourceUrl,
          sourceExternalId,
          sourceMetadata,
          sourceConnectedUserId,
        };

        const response: {
          systemId: string;
          document: MatrixDocumentRow;
          cell?: MatrixCell;
          cells?: MatrixCell[];
          systemPrompts?: SystemPromptRow[];
          systemPromptTitle?: string | null;
          messages?: ThreadChatMessage[];
          systemPrompt?: string | null;
        } = {
          systemId,
          document: nextDocument,
          messages: actionMessages,
        };
        if (payload.kind === "Prompt") {
          const promptMetadata = await getSystemPromptWithMetadataForSystem(systemId);
          response.systemPrompt = promptMetadata.text;
          response.systemPromptTitle = promptMetadata.title;
          response.systemPrompts = promptMetadata.systemPrompts;
        }
        if (shouldAttach && payload.attach) {
          const nextCells = await getMatrixCells(systemId, payload.attach.nodeId, payload.attach.concerns);
          if (nextCells.length > 0) {
            response.cells = nextCells;
            if (nextCells.length === 1) {
              response.cell = nextCells[0];
            }
          }
        }
        return response;
      } catch (error: unknown) {
        if (inTransaction) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Best effort rollback.
          }
        }
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code?: string }).code === "23503"
        ) {
          return reply.code(400).send({ error: "Invalid node, concern, or document reference" });
        }
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.patch<{
    Params: { handle: string; projectName: string; threadId: string; documentHash: string };
    Body: MatrixDocumentReplaceBody;
  }>(
    "/projects/:handle/:projectName/thread/:threadId/matrix/documents/:documentHash",
    async (req, reply) => {
      const { handle, projectName, threadId, documentHash } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const trimmedHash = documentHash.trim();
      const payload = normalizeMatrixDocumentReplaceBody(req.body);
      if (!trimmedHash || !payload) {
        return reply.code(400).send({ error: "Invalid matrix document patch payload" });
      }

      const client = await pool.connect();
      let inTransaction = false;
      let actionMessages: ThreadChatMessage[] = [];

      try {
        await client.query("BEGIN");
        inTransaction = true;

        const actionId = randomUUID();
        const beginResult = await client.query<BeginActionRow>(
          `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
          [context.threadId, actionId, "Edit", "Matrix doc replace"],
        );
        const outputSystemId = beginResult.rows[0]?.output_system_id;
        if (!outputSystemId) {
          throw new Error("Failed to create action output system");
        }

        const existingResult = await client.query<MatrixDocumentRow>(
          `SELECT
             hash,
             kind,
             title,
             language,
             text,
             source_type,
             source_url,
             source_external_id,
             source_metadata,
             source_connected_user_id
           FROM documents
           WHERE system_id = $1 AND hash = $2`,
          [outputSystemId, trimmedHash],
        );
        if (existingResult.rowCount === 0) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return reply.code(404).send({ error: "Document not found" });
        }

        const existing = existingResult.rows[0];
        const isPromptDocument = existing.kind === "Prompt";
        if (isPromptDocument && existing.source_type !== "local") {
          await client.query("ROLLBACK");
          inTransaction = false;
          return reply.code(400).send({ error: "Prompt documents must be local." });
        }

        if (isPromptDocument) {
          const rootNodeId = await getSystemRootNodeId(outputSystemId, client);
          if (!rootNodeId) {
            await client.query("ROLLBACK");
            inTransaction = false;
            return reply.code(500).send({ error: "Unable to resolve system root node" });
          }
        const invalidPromptRefsResult = await client.query<ChangedRow>(
          `SELECT 1 AS changed
           FROM matrix_refs
           WHERE system_id = $1
             AND doc_hash = $2
             AND ref_type = 'Prompt'::ref_type
             AND node_id <> $3
             LIMIT 1`,
            [outputSystemId, trimmedHash, rootNodeId],
        );
        if (invalidPromptRefsResult.rowCount && invalidPromptRefsResult.rowCount > 0) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return reply.code(400).send({
            error: "Prompt documents must remain attached to the system root node.",
          });
        }
        }

        const isRemoteDocument = existing.source_type !== "local";
        if (isRemoteDocument && (typeof payload.body === "string" || typeof payload.name === "string" ||
          typeof payload.description === "string")) {
          await client.query("ROLLBACK");
          inTransaction = false;
          return reply.code(400).send({
            error: "Remote documents cannot be edited as markdown. Use a new import action to refresh snapshot metadata.",
          });
        }

        const parsedExisting = isRemoteDocument ? null : parseDocumentText(existing.text);
        const nextTitle = payload.title ?? existing.title;
        const nextLanguage = payload.language ?? existing.language;
        const nextText = isRemoteDocument
          ? existing.text
          : buildDocumentText({
            name: payload.name ?? (parsedExisting?.name && isValidDocumentName(parsedExisting.name)
              ? parsedExisting.name
              : deriveDocumentName(nextTitle)),
            description: payload.description ?? parsedExisting?.description ?? "",
            body: payload.body ?? parsedExisting?.body ?? "",
          });
        const nextHash = computeDocumentHash({
          kind: existing.kind,
          title: nextTitle,
          language: nextLanguage,
          body: nextText,
        });

        const insertResult = await client.query<MatrixDocumentRow>(
          `INSERT INTO documents (
            hash,
            system_id,
            kind,
            title,
            language,
            text,
            source_type,
            source_url,
            source_external_id,
            source_metadata,
            source_connected_user_id,
            supersedes
           )
           VALUES ($1, $2, $3::doc_kind, $4, $5, $6, $7::doc_source_type, $8, $9, $10, $11, $12)
           ON CONFLICT (system_id, hash) DO NOTHING
           RETURNING hash, kind, title, language, text, source_type, source_url, source_external_id, source_metadata, source_connected_user_id`,
          [
            nextHash,
            outputSystemId,
            existing.kind,
            nextTitle,
            nextLanguage,
            nextText,
            existing.source_type,
            existing.source_url,
            existing.source_external_id,
            existing.source_metadata,
            existing.source_connected_user_id,
            existing.hash,
          ],
        );

        const updateRefsResult = await client.query<ChangedRow>(
          `UPDATE matrix_refs
           SET doc_hash = $3
           WHERE system_id = $1
             AND doc_hash = $2`,
          [outputSystemId, existing.hash, nextHash],
        );

        const changed = (insertResult.rowCount ?? 0) > 0 || (updateRefsResult.rowCount ?? 0) > 0;
        if (!changed) {
          await client.query("SELECT commit_action_empty($1, $2)", [context.threadId, actionId]);
        } else {
          const nodeNames = await getNodeNamesByDocumentHash(client, outputSystemId, nextHash);

          await insertSystemActionMessage(
            client,
            context.threadId,
            actionId,
            buildDocumentModifySummary(existing.title, nextTitle, nodeNames),
          );
          actionMessages = await getActionMessages(client, context.threadId, actionId);
        }

        await client.query("COMMIT");
        inTransaction = false;

        const nextDocument = insertResult.rows[0] ?? {
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
        };

        const systemId = await getThreadSystemId(context.threadId);
        if (!systemId) {
          return reply.code(500).send({ error: "Unable to resolve thread system" });
        }

        const systemPrompt = isPromptDocument
          ? await getSystemPromptWithMetadataForSystem(systemId)
          : undefined;

        return {
          systemId,
          oldHash: existing.hash,
          document: nextDocument,
          replacedRefs: updateRefsResult.rowCount ?? 0,
          messages: actionMessages,
          ...(systemPrompt === undefined ? {} : {
            systemPrompt: systemPrompt.text,
            systemPromptTitle: systemPrompt.title,
            systemPrompts: systemPrompt.systemPrompts,
          }),
        };
      } catch (error) {
        if (inTransaction) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Best effort rollback;
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: { handle: string; projectName: string; threadId: string }; Body: MatrixRefBody }>(
    "/projects/:handle/:projectName/thread/:threadId/matrix/refs",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      let payload = normalizeMatrixMutationBody(req.body);
      if (!payload) {
        return reply.code(400).send({ error: "Invalid matrix reference payload" });
      }

      const client = await pool.connect();
      let inTransaction = false;
      let actionMessages: ThreadChatMessage[] = [];

      try {
        await client.query("BEGIN");
        inTransaction = true;

        const actionId = randomUUID();
        const beginResult = await client.query<BeginActionRow>(
          `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
          [context.threadId, actionId, "Edit", "Matrix doc remove"],
        );

        const outputSystemId = beginResult.rows[0]?.output_system_id;
        if (!outputSystemId) {
          throw new Error("Failed to create action output system");
        }

        if (payload.refType === "Prompt") {
          const validation = await validateSystemPromptAttachment(
            client,
            outputSystemId,
            {
              nodeId: payload.nodeId,
              concern: payload.concern,
              concerns: payload.concerns,
              refType: "Prompt",
              docHash: payload.docHash,
            },
          );
          if (!validation.valid) {
            await client.query("ROLLBACK");
            inTransaction = false;
            return reply.code(400).send({ error: validation.error });
          }
          payload = validation.payload;
        }

        let changed = 0;
        for (const concern of payload.concerns) {
          const deleteResult = await client.query<ChangedRow>(
            `DELETE FROM matrix_refs
             WHERE system_id = $1
               AND node_id = $2
               AND concern_hash = md5($3)
               AND concern = $3
               AND ref_type = $4::ref_type
               AND doc_hash = $5
             RETURNING 1 AS changed`,
            [outputSystemId, payload.nodeId, concern, payload.refType, payload.docHash],
          );
          changed += deleteResult.rowCount ?? 0;
        }

        if (changed === 0) {
          await client.query("SELECT commit_action_empty($1, $2)", [context.threadId, actionId]);
        } else {
          const title = await getDocumentTitleByHash(client, outputSystemId, payload.docHash) ?? payload.docHash;
          const nodeName = await getNodeNameById(client, outputSystemId, payload.nodeId);
          await insertSystemActionMessage(
            client,
            context.threadId,
            actionId,
            buildDocumentRemoveSummary(title, nodeName),
          );
          actionMessages = await getActionMessages(client, context.threadId, actionId);
        }

        await client.query("COMMIT");
        inTransaction = false;
      } catch (error) {
        if (inTransaction) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Best effort rollback.
          }
        }
        throw error;
      } finally {
        client.release();
      }

      const systemId = await getThreadSystemId(context.threadId);
      if (!systemId) {
        return reply.code(500).send({ error: "Unable to resolve thread system" });
      }

      const systemPrompt = payload.refType === "Prompt"
        ? await getSystemPromptWithMetadataForSystem(systemId)
        : undefined;
      const cells = await getMatrixCells(systemId, payload.nodeId, payload.concerns);
      if (cells.length === 1) {
        return systemPrompt === undefined
          ? { systemId, cell: cells[0], cells, messages: actionMessages }
          : {
            systemId,
            cell: cells[0],
            cells,
            systemPrompt: systemPrompt.text,
            systemPromptTitle: systemPrompt.title,
            systemPrompts: systemPrompt.systemPrompts,
            messages: actionMessages,
          };
      }
      return systemPrompt === undefined
        ? { systemId, cells, messages: actionMessages }
        : {
          systemId,
          cells,
          systemPrompt: systemPrompt.text,
          systemPromptTitle: systemPrompt.title,
          systemPrompts: systemPrompt.systemPrompts,
          messages: actionMessages,
        };
    },
  );

  app.post<{ Params: { handle: string; projectName: string; threadId: string }; Body: ChatMessageBody }>(
    "/projects/:handle/:projectName/thread/:threadId/chat/messages",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      if (typeof req.body?.content !== "string" || !req.body.content.trim()) {
        return reply.code(400).send({ error: "content is required" });
      }

      const content = req.body.content.trim();
      const actionId = randomUUID();
      const userMessageId = randomUUID();

      const client = await pool.connect();
      let inTransaction = false;

      try {
        await client.query("BEGIN");
        inTransaction = true;

        await client.query(
          `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
          [context.threadId, actionId, "Chat", "Chat message"],
        );

        await client.query("SELECT commit_action_empty($1, $2)", [context.threadId, actionId]);

        await client.query(
          `INSERT INTO messages (id, thread_id, action_id, role, content, position)
           VALUES ($1, $2, $3, 'User'::message_role, $4, 1)`,
          [
            userMessageId,
            context.threadId,
            actionId,
            content,
          ],
        );

        const messages = await getActionMessages(client, context.threadId, actionId);

        await client.query("COMMIT");
        inTransaction = false;

        return {
          messages,
        };
      } catch (error) {
        if (inTransaction) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Best effort rollback.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: { handle: string; projectName: string; threadId: string }; Body: AssistantRunRequestBody }>(
    "/projects/:handle/:projectName/thread/:threadId/assistant/run",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const parsedBody = parseAssistantRunRequest(req.body);
      if (!parsedBody) {
        return reply.code(400).send({ error: "Invalid request body" });
      }

      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const triggerMessage = await getAssistantRunTriggerMessage(context.threadId, parsedBody.chatMessageId);
      const actionIds: string[] = [];
      const runPrompt = triggerMessage ? triggerMessage.content : "";

      let planActionId: string | null = null;
      let planResponseActionId: string | null = null;
      let executeActionId: string | null = null;
      let executeResponseActionId: string | null = null;
      let updateActionId: string | null = null;
      let execution: {
        status: "success" | "failed";
        messages: string[];
        changes: AssistantRunPlanChange[];
      } = { status: "success", messages: ["No execution run yet."], changes: [] };

      if (parsedBody.executor === "desktop" && parsedBody.mode === "direct") {
        const threadSystemId = await getThreadSystemId(context.threadId);
        if (!threadSystemId) {
          return reply.code(500).send({ error: "Unable to resolve thread system" });
        }
        const { text: systemPromptText } = await getSystemPromptWithMetadataForSystem(threadSystemId);
        const resolvedSystemPrompt = systemPromptText?.trim() || DEFAULT_SYSTEM_PROMPT;
        req.log.info(
          {
            threadId: context.threadId,
            systemPrompt: resolvedSystemPrompt,
          },
          "Passing control to agent with system prompt (desktop direct)",
        );

        const runId = await enqueueAgentRunWithWait({
          threadId: context.threadId,
          projectId: context.projectId,
          requestedByUserId: getViewerUserId(req),
          mode: "direct",
          planActionId: null,
          chatMessageId: parsedBody.chatMessageId,
          prompt: runPrompt,
          model: parsedBody.model,
          systemPrompt: resolvedSystemPrompt,
        }, AGENT_RUN_SLOT_WAIT_MS, AGENT_RUN_ENQUEUE_POLL_MS);

        const systemId = await getThreadSystemId(context.threadId);
        if (!systemId) {
          return reply.code(500).send({ error: "Unable to resolve thread system" });
        }

        if (parsedBody.wait) {
          const completed = await waitForAgentRunCompletion(runId, AGENT_RUN_TIMEOUT_MS, AGENT_RUN_POLL_MS);
          if (!completed) {
            return reply.code(408).send({ error: "Timed out waiting for agent execution to finish." });
          }
        }

        const runRow = await getAgentRunByThreadId(context.threadId, runId);
        if (!runRow) {
          return reply.code(500).send({ error: "Run was not created." });
        }
        const includeThreadState = runRow.status === "success"
          && runRow.run_result_status === "success"
          && (runRow.run_result_changes?.length ?? 0) > 0;
        const threadState = includeThreadState
          ? await buildThreadStatePayload(context).catch(() => undefined)
          : undefined;
        return mapAgentRunRowToResponse({
          runId: runRow.id,
          systemId,
          model: runRow.model,
          runResultStatus: runRow.run_result_status,
          runResultMessages: runRow.run_result_messages,
          runResultChanges: runRow.run_result_changes,
          runError: runRow.run_error,
          threadStatus: runRow.status,
          threadState,
        });
      }

      if (parsedBody.mode === "direct") {
        if (parsedBody.planActionId) {
          const requestedPlan = await loadAction(context.threadId, parsedBody.planActionId);
          if (!requestedPlan || requestedPlan.type !== "Plan") {
            return reply.code(400).send({ error: "Invalid planActionId" });
          }
          planActionId = requestedPlan.id;
        }

        const executeActionClient = await pool.connect();
        let inTransaction = false;
        try {
          await executeActionClient.query("BEGIN");
          inTransaction = true;

          executeActionId = randomUUID();
          const executeUserMessageId = randomUUID();
          const executeSystemMessageId = randomUUID();

          await executeActionClient.query(
            `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
            [context.threadId, executeActionId, "Execute", "Agent execution request"],
          );
          await executeActionClient.query("SELECT commit_action_empty($1, $2)", [context.threadId, executeActionId]);

          await executeActionClient.query(
            `INSERT INTO messages (id, thread_id, action_id, role, content, position)
             VALUES
               ($1, $2, $3, 'User'::message_role, $4, 1),
               ($5, $2, $3, 'System'::message_role, $6, 2)`,
            [
              executeUserMessageId,
              context.threadId,
              executeActionId,
              runPrompt || "Run this request.",
              executeSystemMessageId,
              parsedBody.planActionId ? `Execution requested with plan action ${parsedBody.planActionId}.` : "Execution requested directly.",
            ],
          );

          await executeActionClient.query("COMMIT");
          inTransaction = false;
        } catch (error) {
          if (inTransaction) {
            try {
              await executeActionClient.query("ROLLBACK");
            } catch {
              // Best effort rollback.
            }
          }
          throw error;
        } finally {
          executeActionClient.release();
        }

        if (!executeActionId) {
          return reply.code(500).send({ error: "Unable to create execution action" });
        }
        actionIds.push(executeActionId);

        try {
          const threadSystemId = await getThreadSystemId(context.threadId);
          if (!threadSystemId) {
            return reply.code(500).send({ error: "Unable to resolve thread system" });
          }
          const { text: systemPromptText } = await getSystemPromptWithMetadataForSystem(threadSystemId);
          const resolvedSystemPrompt = systemPromptText?.trim() || DEFAULT_SYSTEM_PROMPT;
          req.log.info(
            {
              threadId: context.threadId,
              systemPrompt: resolvedSystemPrompt,
            },
            "Passing control to agent with system prompt (backend direct execution)",
          );

          const runId = await enqueueAgentRunWithWait({
            threadId: context.threadId,
            projectId: context.projectId,
            requestedByUserId: getViewerUserId(req),
            mode: "direct",
            planActionId,
            chatMessageId: parsedBody.chatMessageId,
            prompt: runPrompt,
            model: parsedBody.model,
            systemPrompt: resolvedSystemPrompt,
          }, AGENT_RUN_SLOT_WAIT_MS, AGENT_RUN_ENQUEUE_POLL_MS);

          const completed = await waitForAgentRunCompletion(runId, AGENT_RUN_TIMEOUT_MS, AGENT_RUN_POLL_MS);
          if (!completed) {
            return reply.code(408).send({ error: "Timed out waiting for agent execution to finish." });
          }

          execution = {
            status: completed.status,
            messages: completed.messages,
            changes: completed.changes,
          };
        } catch (error: unknown) {
          execution = {
            status: "failed",
            messages: [runExecutionError(error)],
            changes: [],
          };
          if (error instanceof Error && error.message.includes("Timeout waiting for a free agent run slot")) {
            return reply.code(408).send({ error: error.message });
          }
        }

        const executeResponseActionClient = await pool.connect();
        let responseInTransaction = false;
        try {
          const executionResponseMessages = summarizeRunMessages(execution.status, execution.messages);
          const executionResponseContent = executionResponseMessages.join(" | ");
          await executeResponseActionClient.query("BEGIN");
          responseInTransaction = true;

          executeResponseActionId = randomUUID();
          const executeResponseMessageId = randomUUID();
          await executeResponseActionClient.query(
            `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
            [context.threadId, executeResponseActionId, "ExecuteResponse", "Agent execution response"],
          );
          await executeResponseActionClient.query("SELECT commit_action_empty($1, $2)", [context.threadId, executeResponseActionId]);

          await executeResponseActionClient.query(
            `INSERT INTO messages (id, thread_id, action_id, role, content, position)
             VALUES ($1, $2, $3, 'Assistant'::message_role, $4, 1)`,
            [executeResponseMessageId, context.threadId, executeResponseActionId, executionResponseContent],
          );

          await executeResponseActionClient.query("COMMIT");
          responseInTransaction = false;
        } catch (error) {
          if (responseInTransaction) {
            try {
              await executeResponseActionClient.query("ROLLBACK");
            } catch {
              // Best effort rollback.
            }
          }
          throw error;
        } finally {
          executeResponseActionClient.release();
        }

        if (!executeResponseActionId) {
          return reply.code(500).send({ error: "Unable to create execution response action" });
        }
        actionIds.push(executeResponseActionId);

        if (execution.status === "success" && execution.changes.length > 0) {
          const updateClient = await pool.connect();
          let updateInTransaction = false;

          try {
            await updateClient.query("BEGIN");
            updateInTransaction = true;

            updateActionId = randomUUID();
            const beginUpdateResult = await updateClient.query<BeginActionRow>(
              `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
              [context.threadId, updateActionId, "Update", "Agent execution changes"],
            );

            if (!beginUpdateResult.rows[0]?.output_system_id) {
              await updateClient.query("ROLLBACK");
              updateInTransaction = false;
              return reply.code(500).send({ error: "Unable to create update action" });
            }

            for (const change of execution.changes) {
              await updateClient.query(
                `INSERT INTO changes (
                   id, thread_id, action_id, target_table, operation, target_id, previous, current
                 )
                 VALUES ($1, $2, $3, $4, $5::change_operation, $6, $7, $8)`,
                [
                  randomUUID(),
                  context.threadId,
                  updateActionId,
                  change.target_table,
                  change.operation,
                  JSON.stringify(change.target_id),
                  change.previous ? JSON.stringify(change.previous) : null,
                  change.current ? JSON.stringify(change.current) : null,
                ],
              );
            }

            await updateClient.query("COMMIT");
            updateInTransaction = false;
          } catch (error) {
            if (updateInTransaction) {
              try {
                await updateClient.query("ROLLBACK");
              } catch {
                // Best effort rollback.
              }
            }
            throw error;
          } finally {
            updateClient.release();
          }

          actionIds.push(updateActionId);
        }
      } else {
        const planActionClient = await pool.connect();
        let planInTransaction = false;
        try {
          await planActionClient.query("BEGIN");
          planInTransaction = true;

          planActionId = randomUUID();
          const planUserMessageId = randomUUID();

          await planActionClient.query(
            `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
            [context.threadId, planActionId, "Plan", "Assistant plan request"],
          );
          await planActionClient.query("SELECT commit_action_empty($1, $2)", [context.threadId, planActionId]);
          await planActionClient.query(
            `INSERT INTO messages (id, thread_id, action_id, role, content, position)
             VALUES ($1, $2, $3, 'User'::message_role, $4, 1)`,
            [planUserMessageId, context.threadId, planActionId, runPrompt || "Run this request in plan mode."],
          );
          await planActionClient.query("COMMIT");
          planInTransaction = false;
        } catch (error) {
          if (planInTransaction) {
            try {
              await planActionClient.query("ROLLBACK");
            } catch {
              // Best effort rollback.
            }
          }
          throw error;
        } finally {
          planActionClient.release();
        }

        if (!planActionId) {
          return reply.code(500).send({ error: "Unable to create plan action" });
        }
        actionIds.push(planActionId);

        const planResponseClient = await pool.connect();
        let planResponseInTransaction = false;
        try {
          await planResponseClient.query("BEGIN");
          planResponseInTransaction = true;

          planResponseActionId = randomUUID();
          const planResponseMessageId = randomUUID();
          await planResponseClient.query(
            `SELECT begin_action($1, $2, $3::action_type, $4) AS output_system_id`,
            [context.threadId, planResponseActionId, "PlanResponse", "Assistant plan response"],
          );
          await planResponseClient.query("SELECT commit_action_empty($1, $2)", [context.threadId, planResponseActionId]);
          await planResponseClient.query(
            `INSERT INTO messages (id, thread_id, action_id, role, content, position)
             VALUES ($1, $2, $3, 'Assistant'::message_role, $4, 1)`,
            [planResponseMessageId, context.threadId, planResponseActionId, generatePlanResponseContent(runPrompt)],
          );

          await planResponseClient.query("COMMIT");
          planResponseInTransaction = false;
        } catch (error) {
          if (planResponseInTransaction) {
            try {
              await planResponseClient.query("ROLLBACK");
            } catch {
              // Best effort rollback.
            }
          }
          throw error;
        } finally {
          planResponseClient.release();
        }
        if (!planResponseActionId) {
          return reply.code(500).send({ error: "Unable to create plan response action" });
        }
        actionIds.push(planResponseActionId);
      }

      const messagesResult = await query<AssistantRunMessageRow>(
        `SELECT m.id, m.action_id, m.role, m.content, m.created_at, a.position AS action_position, a.type AS action_type
         FROM messages m
         JOIN actions a ON a.thread_id = m.thread_id AND a.id = m.action_id
         WHERE m.thread_id = $1 AND m.action_id = ANY($2::text[])
         ORDER BY a.position, m.position`,
        [context.threadId, actionIds],
      );

      const systemId = await getThreadSystemId(context.threadId);
      if (!systemId) {
        return reply.code(500).send({ error: "Unable to resolve thread system" });
      }

      const summary = parsedBody.mode === "direct"
        ? assistantRunSummary(execution.status, summarizeRunMessages(execution.status, execution.messages))
        : assistantRunSummary("success", ["Plan generated."]);
      const filesChanged = parsedBody.mode === "direct" && execution.status === "success"
        ? extractAssistantRunChangedFiles(execution.changes)
        : [];

      const changesCount = parsedBody.mode === "direct" && execution.status === "success"
        ? execution.changes.length
        : 0;
      const threadState = parsedBody.mode === "direct" && execution.status === "success" && changesCount > 0
        ? await buildThreadStatePayload(context).catch(() => undefined)
        : undefined;
      return {
        planActionId,
        planResponseActionId,
        executeActionId,
        executeResponseActionId,
        updateActionId,
        filesChanged,
        summary,
        changesCount,
        messages: mapAssistantRunMessages(messagesResult.rows),
        systemId,
        ...(threadState ? { threadState } : {}),
      };
    },
  );

  app.get<{ Params: { handle: string; projectName: string; threadId: string } }>(
    "/projects/:handle/:projectName/thread/:threadId/openship/bundle",
    async (req, reply) => {
      const { handle, projectName, threadId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const systemId = await getThreadSystemId(context.threadId);
      if (!systemId) {
        return reply.code(500).send({ error: "Unable to resolve thread system" });
      }

      const descriptor = await buildOpenShipBundleDescriptor(context.threadId, systemId);
      return descriptor;
    },
  );

  app.post<{ Params: { handle: string; projectName: string; threadId: string; runId: string }; Body: AssistantRunClaimRequestBody }>(
    "/projects/:handle/:projectName/thread/:threadId/assistant/run/:runId/claim",
    async (req, reply) => {
      const { handle, projectName, threadId, runId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const runnerId = typeof req.body?.runnerId === "string" && req.body.runnerId.trim()
        ? req.body.runnerId.trim()
        : null;
      const claimed = await claimAgentRunById(runId, runnerId ?? `desktop-${process.env.HOSTNAME ?? "local"}`, context.threadId);
      if (!claimed) {
        return reply.code(409).send({ error: "Run is not available for claiming." });
      }

      if (claimed.thread_id !== context.threadId) {
        return reply.code(404).send({ error: "Run not found." });
      }

      const systemId = await getThreadSystemId(context.threadId);
      if (!systemId) {
        return reply.code(500).send({ error: "Unable to resolve thread system" });
      }

      return {
        runId: claimed.id,
        status: claimed.status,
        prompt: claimed.prompt,
        systemPrompt: claimed.system_prompt,
        model: claimed.model,
        systemId,
      };
    },
  );

  app.post<
    {
      Params: { handle: string; projectName: string; threadId: string; runId: string };
      Body: AssistantRunCompleteRequestBody;
    }
  >(
    "/projects/:handle/:projectName/thread/:threadId/assistant/run/:runId/complete",
    async (req, reply) => {
      const { handle, projectName, threadId, runId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const parsed = req.body;
      if (!parsed || typeof parsed.status !== "string" || !Array.isArray(parsed.messages) || !Array.isArray(parsed.changes)) {
        return reply.code(400).send({ error: "Invalid complete payload" });
      }

      const openShipBundleFiles = parseOpenShipBundleFiles(parsed.openShipBundleFiles);
      if (openShipBundleFiles === null) {
        return reply.code(400).send({ error: "Invalid OpenShip bundle files payload" });
      }

      const run = await getAgentRunByThreadId(context.threadId, runId);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }
      if (run.thread_id !== context.threadId) {
        return reply.code(404).send({ error: "Run not found" });
      }

      const runnerId = typeof parsed.runnerId === "string" && parsed.runnerId.trim()
        ? parsed.runnerId.trim()
        : undefined;
      const completionClient = await pool.connect();
      let completionRunUpdateApplied = false;
      let responseActionId: string | null = null;
      let responseMessages: AssistantRunMessageRow[] = [];
      let completionStatus: "success" | "failed" = parsed.status === "failed" ? "failed" : "success";
      let completionMessages = [...parsed.messages];
      let completionError = parsed.error;
      let completionThreadState: ThreadDetailPayload | undefined;

      if (completionStatus === "success" && parsed.changes.length > 0 && openShipBundleFiles.length > 0) {
        try {
          await applyOpenShipBundleToThreadSystem({
            threadId: context.threadId,
            bundleFiles: openShipBundleFiles,
          });
          completionThreadState = await buildThreadStatePayload(context);
        } catch (error: unknown) {
          completionStatus = "failed";
          const reconcileError = runExecutionError(error);
          completionError = completionError ? `${completionError} / OpenShip reconciliation failed: ${reconcileError}` : `OpenShip reconciliation failed: ${reconcileError}`;
          completionMessages = [...completionMessages, `OpenShip reconciliation failed: ${reconcileError}`];
        }
      }

      try {
        completionRunUpdateApplied = await updateAgentRunResult(
          run.id,
          completionStatus,
          {
            status: completionStatus,
            messages: sanitizeAgentRunMessages(completionMessages),
            changes: parsed.changes,
            error: completionError,
          },
          parsed.error,
          runnerId,
        );
        req.log.info(
          {
            runId: run.id,
            completionRunUpdateApplied,
            completionStatus,
            runnerId,
          },
          "updateAgentRunResult result",
        );
        const normalizedCompletionStatus = completionStatus === "failed" ? "failed" : "success";
        await completionClient.query("BEGIN");
        if (completionRunUpdateApplied) {
          const completionRecord = await persistDesktopAgentRunCompletionMessage(
            completionClient,
            context.threadId,
            {
              status: normalizedCompletionStatus,
              messages: sanitizeAgentRunMessages(completionMessages),
              changes: parsed.changes,
              error: completionError,
            },
            normalizedCompletionStatus,
          );
          responseActionId = completionRecord?.responseActionId ?? null;
        }
        await completionClient.query("COMMIT");
      } catch (error) {
        try {
          await completionClient.query("ROLLBACK");
        } catch {
          // Best effort rollback.
        }
        throw error;
      } finally {
        completionClient.release();
      }

      const updated = await getAgentRunByThreadId(context.threadId, run.id);
      if (!updated) {
        return reply.code(404).send({ error: "Run not found" });
      }
      const systemId = await getThreadSystemId(context.threadId);
      if (!systemId) {
        return reply.code(500).send({ error: "Unable to resolve thread system" });
      }
      if (responseActionId) {
        const responseMessageRows = await query<AssistantRunMessageRow>(
          `SELECT m.id, m.action_id, m.role, m.content, m.created_at, a.position AS action_position, a.type AS action_type
           FROM messages m
           JOIN actions a ON a.thread_id = m.thread_id AND a.id = m.action_id
           WHERE m.thread_id = $1 AND m.action_id = $2
           ORDER BY m.position`,
          [context.threadId, responseActionId],
        );
        responseMessages = responseMessageRows.rows;
      }

      return mapAgentRunRowToResponse({
        runId: updated.id,
        systemId,
        model: updated.model,
        runResultStatus: updated.run_result_status,
        runResultMessages: updated.run_result_messages,
        runResultChanges: updated.run_result_changes,
        runError: updated.run_error,
        messages: responseMessages,
        threadStatus: updated.status,
        threadState: completionStatus === "success" && (updated.run_result_changes?.length ?? 0) > 0
          ? completionThreadState
          : undefined,
      });
    },
  );

  app.get<{ Params: { handle: string; projectName: string; threadId: string; runId: string } }>(
    "/projects/:handle/:projectName/thread/:threadId/assistant/run/:runId",
    async (req, reply) => {
      const { handle, projectName, threadId, runId } = req.params;
      const context = await requireContext(reply, getViewerUserId(req), handle, projectName, threadId);
      if (!context) return;

      if (!canEdit(context.accessRole)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const run = await getAgentRunByThreadId(context.threadId, runId);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }
      if (run.thread_id !== context.threadId) {
        return reply.code(404).send({ error: "Run not found" });
      }

      const systemId = await getThreadSystemId(context.threadId);
      if (!systemId) {
        return reply.code(500).send({ error: "Unable to resolve thread system" });
      }

      const shouldIncludeThreadState = run.status === "success"
        && run.run_result_status === "success"
        && (run.run_result_changes?.length ?? 0) > 0;
      const threadState = shouldIncludeThreadState
        ? await buildThreadStatePayload(context).catch(() => undefined)
        : undefined;
      let runMessages: AssistantRunMessageRow[] = [];
      if (run.status === "success" || run.status === "failed" || run.status === "cancelled") {
        const runMessageRows = await query<AssistantRunMessageRow>(
          `SELECT m.id, m.action_id, m.role, m.content, m.created_at, a.position AS action_position, a.type AS action_type
           FROM messages m
           JOIN actions a ON a.thread_id = m.thread_id AND a.id = m.action_id
           WHERE m.thread_id = $1
             AND a.type = 'ExecuteResponse'
             AND m.created_at >= $2
           ORDER BY m.created_at DESC, m.position DESC`,
          [context.threadId, run.created_at],
        );
        runMessages = runMessageRows.rows;
      }

      return mapAgentRunRowToResponse({
        runId: run.id,
        systemId,
        model: run.model,
        runResultStatus: run.run_result_status,
        runResultMessages: run.run_result_messages,
        runResultChanges: run.run_result_changes,
        runError: run.run_error,
        messages: runMessages,
        threadStatus: run.status,
        threadState,
      });
    },
  );
}
