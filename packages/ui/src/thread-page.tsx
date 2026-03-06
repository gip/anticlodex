import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  CheckCircle2,
  LayoutGrid,
  Minimize2,
  Pencil,
  Plus,
  Send,
  X,
} from "lucide-react";
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import ReactFlow, {
  Background,
  ControlButton,
  Controls,
  Handle,
  MarkerType,
  Position,
  useNodesState,
  type NodeMouseHandler,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import { Link } from "./link";
import { useAuth } from "./auth-context";
import { isFinalizedThreadStatus, type ThreadStatus } from "./home";
import { renderMarkdown } from "./markdown";

type DocKind = "Document" | "Skill";
type MessageRole = "User" | "Assistant" | "System";
type DocumentMutationKind = DocKind | "Prompt";
type DocSourceType = "local" | "notion" | "google_doc";
export type IntegrationProvider = "notion" | "google";
export type IntegrationConnectionStatus = "connected" | "disconnected" | "expired" | "needs_reauth";
export type IntegrationStatusRecord = Record<IntegrationProvider, IntegrationConnectionStatus>;

export interface ThreadPermissions {
  canEdit: boolean;
  canChat: boolean;
}

export interface TopologyNode {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
  layoutX?: number | null;
  layoutY?: number | null;
  ownership: "first_party" | "third_party";
  boundary: "internal" | "external";
}

export interface TopologyEdge {
  id: string;
  type: string;
  fromNodeId: string;
  toNodeId: string;
  protocol?: string | null;
  layer7?: string | null;
}

export interface MatrixCellDoc {
  hash: string;
  title: string;
  kind: DocKind;
  language: string;
  refType: DocKind;
  sourceType?: DocSourceType;
  sourceUrl?: string | null;
  sourceExternalId?: string | null;
  sourceMetadata?: Record<string, unknown> | null;
  sourceConnectedUserId?: string | null;
}

export interface ArtifactRef {
  id: string;
  type: string;
  language: string;
  text: string | null;
}

export interface MatrixCell {
  nodeId: string;
  concern: string;
  docs: MatrixCellDoc[];
  artifacts: ArtifactRef[];
}

interface SystemPromptMeta {
  hash: string;
  title: string;
  text: string;
}

export interface MatrixDocument {
  hash: string;
  kind: DocKind;
  title: string;
  language: string;
  text: string;
  sourceType?: DocSourceType;
  sourceUrl?: string | null;
  sourceExternalId?: string | null;
  sourceMetadata?: Record<string, unknown> | null;
  sourceConnectedUserId?: string | null;
}

export interface ChatMessage {
  id: string;
  actionId: string;
  actionType?: string;
  actionPosition?: number;
  role: MessageRole;
  content: string;
  senderName?: string;
  createdAt: string;
}

export type AssistantRunMode = "direct" | "plan";

export type AssistantExecutor = "backend" | "desktop";

type AssistantModel = "claude-opus-4-6" | "claude-sonnet-4-6" | "codex-5.3";

interface AssistantModelOption {
  key: AssistantModel;
  label: string;
}

const ASSISTANT_MODELS: AssistantModelOption[] = [
  { key: "claude-opus-4-6", label: "Opus 4.6" },
  { key: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { key: "codex-5.3", label: "Codex 5.3" },
];

const DEFAULT_ASSISTANT_MODEL: AssistantModel = "claude-opus-4-6";
const MODEL_STORAGE_KEY_PREFIX = "acx-thread-agent-model";
const MODEL_STORAGE_KEY_GLOBAL = "acx-thread-agent-model-default";
const TOPOLOGY_ELK = new ELK();
const TOPOLOGY_ELK_LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.nodeNode": "80",
  "elk.spacing.edgeNode": "40",
} as const;

function resolveAssistantModel(raw: string | null | undefined): AssistantModel {
  const normalized = raw?.trim() ?? "";
  return ASSISTANT_MODELS.some((model) => model.key === normalized) ? (normalized as AssistantModel) : DEFAULT_ASSISTANT_MODEL;
}

function threadModelStorageKey(threadId: string): string {
  return `${MODEL_STORAGE_KEY_PREFIX}:${threadId}`;
}

function readStoredAssistantModel(threadId: string): AssistantModel {
  try {
    const threadScoped = localStorage.getItem(threadModelStorageKey(threadId));
    const fallback = localStorage.getItem(MODEL_STORAGE_KEY_GLOBAL);
    return resolveAssistantModel(threadScoped || fallback);
  } catch {
    return DEFAULT_ASSISTANT_MODEL;
  }
}

export interface AssistantRunRequest {
  chatMessageId: string | null;
  mode: AssistantRunMode;
  planActionId: string | null;
  executor?: AssistantExecutor;
  wait?: boolean;
  model?: string;
}

export interface AssistantRunResponse {
  runId?: string;
  status?: "queued" | "running" | "success" | "failed" | "cancelled";
  mode?: AssistantRunMode;
  threadId?: string;
  systemId?: string;
  planActionId?: string | null;
  planResponseActionId?: string | null;
  executeActionId?: string | null;
  executeResponseActionId?: string | null;
  updateActionId?: string | null;
  filesChanged?: {
    kind: "Create" | "Update" | "Delete";
    path: string;
    fromHash?: string;
    toHash?: string;
  }[];
  summary?: {
    status: "success" | "failed" | "cancelled" | "queued" | "running";
    messages: string[];
  };
  runResultStatus?: "success" | "failed" | null;
  runResultMessages?: string[];
  runResultChanges?: unknown[];
  runError?: string | null;
  changesCount?: number;
  messages?: ChatMessage[];
  threadState?: ThreadDetailPayload;
}

type AssistantRunSummaryStatus = "success" | "failed" | "cancelled" | "queued" | "running";

function getRunSummary(response: AssistantRunResponse): { status: AssistantRunSummaryStatus; messages: string[] } {
  if (response.summary?.status) {
    return {
      status: response.summary.status,
      messages: response.summary.messages,
    };
  }

  const fromStatus = response.status ?? "queued";
  const mappedStatus: AssistantRunSummaryStatus = (() => {
    if (fromStatus === "cancelled") return "cancelled";
    if (fromStatus === "failed") return "failed";
    if (fromStatus === "success") return "success";
    if (fromStatus === "running") return "running";
    return "queued";
  })();

  return {
    status: response.runResultStatus === "failed" ? "failed" : mappedStatus,
    messages: response.runResultMessages ?? [],
  };
}

export interface ThreadDetail {
  id: string;
  title: string;
  description: string | null;
  status: ThreadStatus;
  createdAt: string;
  createdByHandle: string;
  ownerHandle: string;
  projectName: string;
  accessRole: string;
}

export interface ThreadDetailPayload {
  systemId: string;
  thread: ThreadDetail;
  permissions: ThreadPermissions;
  systemPrompt: string | null;
  systemPromptTitle: string | null;
  systemPrompts: SystemPromptMeta[];
  topology: {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
  };
  matrix: {
    concerns: Array<{ name: string; position: number }>;
    nodes: TopologyNode[];
    cells: MatrixCell[];
    documents: MatrixDocument[];
  };
  chat: {
    messages: ChatMessage[];
  };
}

interface MutationError {
  error: string;
}

type MutationResult<T> = T | MutationError | void;

interface MatrixRefInput {
  nodeId: string;
  concern: string;
  concerns?: string[];
  docHash: string;
  refType: DocumentMutationKind;
}

interface MatrixDocumentCreateInput {
  title: string;
  kind: DocumentMutationKind;
  language: string;
  sourceType: DocSourceType;
  sourceUrl?: string;
  name?: string;
  description?: string;
  body?: string;
  attach?: {
    nodeId: string;
    concern?: string;
    concerns?: string[];
    refType: DocumentMutationKind;
  };
}

interface MatrixDocumentReplaceInput {
  title?: string;
  name?: string;
  description?: string;
  language?: string;
  body?: string;
}

interface MatrixDocumentParsedText {
  name: string;
  description: string;
  body: string;
}

interface MatrixRefMutationResponse {
  systemId: string;
  cell?: MatrixCell;
  cells?: MatrixCell[];
  messages?: ChatMessage[];
}

interface MatrixDocumentCreateResponse {
  systemId: string;
  document: MatrixDocument;
  cell?: MatrixCell;
  cells?: MatrixCell[];
  messages?: ChatMessage[];
}

interface MatrixDocumentReplaceResponse {
  systemId: string;
  oldHash: string;
  document: MatrixDocument;
  replacedRefs: number;
  messages?: ChatMessage[];
}

interface MatrixDocGroup {
  document: MatrixCellDoc[];
  skill: MatrixCellDoc[];
}

type MatrixDocumentModalSource = "matrix-cell" | "topology-node";
type MatrixDocumentModalMode = "browse" | "create" | "edit";

interface MatrixDocumentModal {
  source: MatrixDocumentModalSource;
  nodeId: string;
  refType: DocumentMutationKind;
  concern: string;
  concerns: string[];
  kindFilter: "All" | DocKind;
}

interface ThreadPageProps {
  detail: ThreadDetailPayload;
  threadRouteId?: string;
  onUpdateThread?: (payload: { title?: string; description?: string | null }) => Promise<MutationResult<{ thread: ThreadDetail }>>;
  onSaveTopologyLayout?: (payload: { positions: Array<{ nodeId: string; x: number; y: number }> }) => Promise<MutationResult<{ systemId: string }>>;
  onAddMatrixDoc?: (
    payload: MatrixRefInput,
  ) => Promise<MutationResult<MatrixRefMutationResponse>>;
  onRemoveMatrixDoc?: (
    payload: MatrixRefInput,
  ) => Promise<MutationResult<MatrixRefMutationResponse>>;
  onCreateMatrixDocument?: (payload: MatrixDocumentCreateInput) => Promise<MutationResult<MatrixDocumentCreateResponse>>;
  onReplaceMatrixDocument?: (documentHash: string, payload: MatrixDocumentReplaceInput) => Promise<MutationResult<MatrixDocumentReplaceResponse>>;
  onSendChatMessage?: (payload: { content: string }) => Promise<MutationResult<{ messages: ChatMessage[] }>>;
  onRunAssistant?: (payload: AssistantRunRequest) => Promise<MutationResult<AssistantRunResponse>>;
  assistantRunDisabledMessage?: string | null;
  onCloseThread?: () => Promise<MutationResult<{ thread: ThreadDetail }>>;
  onCommitThread?: () => Promise<MutationResult<{ thread: ThreadDetail }>>;
  onCloneThread?: (payload: { title: string; description: string }) => Promise<MutationResult<{ thread: ThreadDetail }>>;
  integrationStatuses?: IntegrationStatusRecord;
  disableChatInputs?: boolean;
}

const SYSTEM_PROMPT_CONCERN = "__system_prompt__";
const DOC_TYPES: DocKind[] = ["Document", "Skill"];
const SOURCE_TYPE_TO_PROVIDER: Record<Exclude<DocSourceType, "local">, IntegrationProvider> = {
  notion: "notion",
  google_doc: "google",
};
const SOURCE_TYPE_LABELS: Record<DocSourceType, string> = {
  local: "Local",
  notion: "Notion Page",
  google_doc: "Google Docs",
};
const DOC_KIND_TO_KEY: Record<DocKind, keyof MatrixDocGroup> = {
  Document: "document",
  Skill: "skill",
};
function chunkIntoPairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += 2) {
    rows.push(items.slice(index, index + 2));
  }
  return rows;
}
const MATRIX_DOC_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const normalizeConcernName = (value: string) => value.trim().toLowerCase();
const DEFAULT_DOCUMENT_LANGUAGE = "en";
const isHiddenMatrixConcern = (name: string) => name === SYSTEM_PROMPT_CONCERN;
const normalizeMatrixConcerns = (concerns: { name: string; position: number }[]) =>
  concerns.filter((concern) => !isHiddenMatrixConcern(concern.name));

function parseDocumentText(rawText: string): MatrixDocumentParsedText {
  const text = (rawText ?? "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return { name: "", description: "", body: text.trim() };
  }

  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { name: "", description: "", body: text.trim() };
  }

  const frontMatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const parsed: MatrixDocumentParsedText = { name: "", description: "", body };

  for (const line of frontMatter.split("\n")) {
    const [rawKey, rawValue] = line.split(":", 2);
    if (!rawKey || rawValue === undefined) continue;
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key === "name") parsed.name = value;
    else if (key === "description") parsed.description = value;
  }

  return parsed;
}

function isValidDocumentName(name: string) {
  return MATRIX_DOC_NAME_PATTERN.test(name);
}

function deriveDocumentName(title: string) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeAgo(value: string) {
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

function buildMatrixCellKey(nodeId: string, concern: string) {
  return `${nodeId}::${concern}`;
}

function getErrorMessage<T>(result: MutationResult<T>): string | null {
  if (!result || typeof result !== "object") return null;
  if (!("error" in result)) return null;
  const value = result.error;
  return typeof value === "string" ? value : "Request failed";
}

function getStatusLabel(status: ThreadStatus) {
  if (status === "open") return "Working";
  if (status === "closed") return "Closed";
  if (status === "committed") return "Committed";
  return status;
}

function getThreadStatusClass(status: ThreadStatus) {
  if (status === "committed") return "committed";
  if (status === "closed") return "closed";
  return status;
}

function getIntegrationStatus(
  statuses: IntegrationStatusRecord | undefined,
  sourceType: DocSourceType,
): IntegrationConnectionStatus | undefined {
  const provider = sourceType === "local" ? undefined : SOURCE_TYPE_TO_PROVIDER[sourceType];
  if (!provider || !statuses) return undefined;
  return statuses[provider];
}

function isIntegrationConnected(status: IntegrationConnectionStatus | undefined) {
  return status === "connected";
}

function sortNodes(a: TopologyNode, b: TopologyNode) {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

function sortMatrixTopLevelNodes(a: TopologyNode, b: TopologyNode) {
  const priority = (node: TopologyNode) => {
    if (node.kind === "Library") return 0;
    if (node.kind === "Host") return 1;
    return 2;
  };
  const byPriority = priority(a) - priority(b);
  if (byPriority !== 0) return byPriority;
  return sortNodes(a, b);
}

type TopologyOwnership = TopologyNode["ownership"];
type TopologyBoundary = TopologyNode["boundary"];
const ALL_TOPOLOGY_OWNERSHIPS = new Set<TopologyOwnership>(["first_party", "third_party"]);
const ALL_TOPOLOGY_BOUNDARIES = new Set<TopologyBoundary>(["internal", "external"]);

function normalizeTopologyOwnership(value: unknown): "first_party" | "third_party" | null {
  if (value === "first_party" || value === "third_party") return value;
  return null;
}

function normalizeTopologyBoundary(value: unknown): "internal" | "external" | null {
  if (value === "internal" || value === "external") return value;
  return null;
}

function matchesTopologyFilters(
  node: TopologyNode,
  visibleOwnerships: Set<TopologyOwnership>,
  visibleBoundaries: Set<TopologyBoundary>,
): boolean {
  const ownership = normalizeTopologyOwnership(node.ownership);
  const boundary = normalizeTopologyBoundary(node.boundary);
  const ownershipVisible = ownership !== null && visibleOwnerships.has(ownership);
  const boundaryVisible = boundary !== null && visibleBoundaries.has(boundary);
  return ownershipVisible && boundaryVisible;
}

function computeVisibleTopologyNodeIds(
  nodes: TopologyNode[],
  visibleOwnerships: Set<TopologyOwnership>,
  visibleBoundaries: Set<TopologyBoundary>,
): Set<string> {
  const childrenByParent = new Map<string, TopologyNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push(node);
    childrenByParent.set(node.parentId, list);
  }

  const directMatches = new Map<string, boolean>();
  for (const node of nodes) {
    directMatches.set(node.id, matchesTopologyFilters(node, visibleOwnerships, visibleBoundaries));
  }

  const cache = new Map<string, boolean>();
  const inProgress = new Set<string>();

  const subtreeMatches = (nodeId: string): boolean => {
    const cached = cache.get(nodeId);
    if (typeof cached === "boolean") return cached;
    if (inProgress.has(nodeId)) {
      return directMatches.get(nodeId) ?? false;
    }
    inProgress.add(nodeId);

    let visible = directMatches.get(nodeId) ?? false;
    if (!visible) {
      for (const child of childrenByParent.get(nodeId) ?? []) {
        if (!subtreeMatches(child.id)) continue;
        visible = true;
        break;
      }
    }

    inProgress.delete(nodeId);
    cache.set(nodeId, visible);
    return visible;
  };

  const includedNodeIds = new Set<string>();
  for (const node of nodes) {
    if (!subtreeMatches(node.id)) continue;
    includedNodeIds.add(node.id);
  }
  return includedNodeIds;
}

interface FlowLayoutModel {
  byId: Map<string, TopologyNode>;
  includedNodeIds: Set<string>;
  visibleNodes: TopologyNode[];
  hiddenNodeIds: Set<string>;
  visibleParentById: Map<string, string | null>;
  nestedChildrenByHost: Map<string, TopologyNode[]>;
  rootNode: TopologyNode | null;
}

interface TopologyNestedChildData {
  id: string;
  name: string;
  kind: string;
  documents: MatrixDocGroup;
  artifacts: ArtifactRef[];
}

interface TopologyFlowNodeData {
  nodeId: string;
  name: string;
  kind: string;
  nestedChildren: TopologyNestedChildData[];
  documents: MatrixDocGroup;
  artifacts: ArtifactRef[];
  canEdit: boolean;
  onOpenDocPicker: (nodeId: string, refType: DocKind) => void;
  onEditDoc: (doc: MatrixCellDoc, nodeId: string, concern: string) => void;
}

interface FlowEndpoint {
  nodeId: string;
  handleId: string;
}

interface AppliedElkLayout {
  nodes: Node[];
  positions: Array<{ nodeId: string; x: number; y: number }>;
}

interface RootGroupBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AutoLayoutRunOptions {
  sourceNodes?: Node[];
  persist?: boolean;
}

function FullscreenIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6V2.5H6" />
      <path d="M10 2.5h3.5V6" />
      <path d="M13.5 10v3.5H10" />
      <path d="M6 13.5H2.5V10" />
    </svg>
  );
}

function TopologyFlowNode({ data }: NodeProps<TopologyFlowNodeData>) {
  const resolveBadgeKindClass = (kind: string) => {
    const normalizedKind = kind.toLowerCase().replace(/\s+/g, "-");
    return ["host", "process", "container", "library"].includes(normalizedKind)
      ? `thread-topology-node-badge--${normalizedKind}`
      : "thread-topology-node-badge--other";
  };

  const nodeKindClass = resolveBadgeKindClass(data.kind);

  const renderDocSections = (
    nodeLabel: string,
    nodeId: string,
    nodeDocuments: MatrixDocGroup,
    nodeArtifacts: ArtifactRef[],
  ) => (
    <div className="thread-topology-doc-sections">
      <div className="thread-topology-doc-section">
        <div className="thread-topology-doc-section-header">
          <span className="matrix-doc-group-label">Docs</span>
          {data.canEdit && (
            <button
              className="btn-icon thread-topology-doc-add"
              type="button"
              aria-label={`Add Document to ${nodeLabel}`}
              onClick={() => data.onOpenDocPicker(nodeId, "Document")}
              title="Add document"
            >
              <Plus size={12} />
            </button>
          )}
        </div>
        <div className="thread-topology-doc-list">
          {chunkIntoPairs(nodeDocuments.document).map((row, rowIndex) => (
            <div key={`${nodeId}-document-row-${rowIndex}`} className="matrix-doc-row">
              {row.map((doc) => (
                <div
                  className={`matrix-doc-chip matrix-doc-chip--document ${doc.sourceType === "notion" || doc.sourceType === "google_doc" ? "matrix-doc-chip--external" : ""}`}
                  role={data.canEdit ? "button" : undefined}
                  tabIndex={data.canEdit ? 0 : -1}
                  key={`${nodeId}-${doc.hash}-${doc.refType}`}
                  onClick={() => data.canEdit && data.onEditDoc(doc, nodeId, "")}
                  onKeyDown={(event) => {
                    if (!data.canEdit) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      data.onEditDoc(doc, nodeId, "");
                    }
                  }}
                >
                  <span>{doc.title}</span>
                  {doc.sourceType && doc.sourceType !== "local" && (
                    <span className={`matrix-doc-chip-source matrix-doc-chip-source--${doc.sourceType}`}>
                      {SOURCE_TYPE_LABELS[doc.sourceType]}
                    </span>
                  )}
                  {doc.sourceUrl ? (
                    <a
                      className="matrix-doc-open-source"
                      href={doc.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <ExternalLink size={12} />
                      Open source
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="thread-topology-doc-section">
        <div className="thread-topology-doc-section-header">
          <span className="matrix-doc-group-label">Skills</span>
          {data.canEdit && (
            <button
              className="btn-icon thread-topology-doc-add"
              type="button"
              aria-label={`Add Skill to ${nodeLabel}`}
              onClick={() => data.onOpenDocPicker(nodeId, "Skill")}
              title="Add skill"
            >
              <Plus size={12} />
            </button>
          )}
        </div>
        <div className="thread-topology-doc-list">
          {chunkIntoPairs(nodeDocuments.skill).map((row, rowIndex) => (
            <div key={`${nodeId}-skill-row-${rowIndex}`} className="matrix-doc-row">
              {row.map((doc) => (
                <div
                  className={`matrix-doc-chip matrix-doc-chip--skill ${doc.sourceType === "notion" || doc.sourceType === "google_doc" ? "matrix-doc-chip--external" : ""}`}
                  role={data.canEdit ? "button" : undefined}
                  tabIndex={data.canEdit ? 0 : -1}
                  key={`${nodeId}-${doc.hash}-${doc.refType}`}
                  onClick={() => data.canEdit && data.onEditDoc(doc, nodeId, "")}
                  onKeyDown={(event) => {
                    if (!data.canEdit) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      data.onEditDoc(doc, nodeId, "");
                    }
                  }}
                >
                  <span>{doc.title}</span>
                  {doc.sourceType && doc.sourceType !== "local" && (
                    <span className={`matrix-doc-chip-source matrix-doc-chip-source--${doc.sourceType}`}>
                      {SOURCE_TYPE_LABELS[doc.sourceType]}
                    </span>
                  )}
                  {doc.sourceUrl ? (
                    <a
                      className="matrix-doc-open-source"
                      href={doc.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <ExternalLink size={12} />
                      Open source
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      {nodeArtifacts.length > 0 ? (
        <div className="thread-topology-doc-section">
          <div className="thread-topology-doc-section-header">
            <span className="matrix-doc-group-label">Artifacts</span>
          </div>
          <div className="matrix-artifacts">
            {nodeArtifacts.map((artifact) => (
              <span key={artifact.id} className="matrix-artifact-badge">
                {artifact.type}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
  return (
    <div className="thread-topology-node">
      <span className={`thread-topology-node-badge ${nodeKindClass}`}>{data.kind}</span>
      <Handle
        type="target"
        position={Position.Left}
        id="host-in"
        className="thread-topology-handle thread-topology-handle--host"
        style={{ top: 22 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="host-out"
        className="thread-topology-handle thread-topology-handle--host"
        style={{ top: 22 }}
      />

      <strong>{data.name}</strong>

      {renderDocSections(data.name, data.nodeId, data.documents, data.artifacts)}

      {data.nestedChildren.length > 0 && (
        <div className="thread-topology-nested-list">
          {data.nestedChildren.map((child) => (
            <div
              className={`thread-topology-nested-item ${
                child.kind.toLowerCase() === "process" ? "thread-topology-nested-item--process" : ""
              }`}
              key={child.id}
            >
              <span className={`thread-topology-node-badge ${resolveBadgeKindClass(child.kind)}`}>{child.kind}</span>
              <Handle
                type="target"
                position={Position.Left}
                id={`child-in:${child.id}`}
                className="thread-topology-handle thread-topology-handle--child"
                style={{ top: "50%" }}
              />
              <Handle
                type="source"
                position={Position.Right}
                id={`child-out:${child.id}`}
                className="thread-topology-handle thread-topology-handle--child"
                style={{ top: "50%" }}
              />
              <strong>{child.name}</strong>
              {renderDocSections(child.name, child.id, child.documents, child.artifacts)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface RootGroupNodeData {
  name: string;
  nodeId: string;
  documents: MatrixDocGroup;
  artifacts: ArtifactRef[];
  canEdit: boolean;
  onOpenDocPicker: (nodeId: string, refType: DocKind) => void;
  onEditDoc: (doc: MatrixCellDoc, nodeId: string, concern: string) => void;
  onOpenSystemPrompt: (nodeId: string, prompt?: SystemPromptMeta | null) => void;
  systemPrompt: string | null;
  systemPromptTitle: string | null;
  systemPrompts: SystemPromptMeta[];
}

function RootGroupNode({ data }: NodeProps<RootGroupNodeData>) {
  const hasPrompt = data.systemPrompts.length > 0;
  const hasContent = data.canEdit || hasPrompt || data.documents.document.length > 0 || data.documents.skill.length > 0 || data.artifacts.length > 0;
  const openSystemPrompt = () => data.onOpenSystemPrompt(data.nodeId);
  const openSystemPromptEditor = (prompt: SystemPromptMeta) => data.onOpenSystemPrompt(data.nodeId, prompt);

  const renderChips = (docs: MatrixCellDoc[], kind: "document" | "skill") =>
    docs.map((doc) => (
      <div
        className={`matrix-doc-chip matrix-doc-chip--${kind} ${doc.sourceType === "notion" || doc.sourceType === "google_doc" ? "matrix-doc-chip--external" : ""}`}
        role={data.canEdit ? "button" : undefined}
        tabIndex={data.canEdit ? 0 : -1}
        key={`root-${doc.hash}-${doc.refType}`}
        onClick={() => data.canEdit && data.onEditDoc(doc, data.nodeId, "")}
        onKeyDown={(event) => {
          if (!data.canEdit) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            data.onEditDoc(doc, data.nodeId, "");
          }
        }}
      >
        <span>{doc.title}</span>
        {doc.sourceType && doc.sourceType !== "local" && (
          <span className={`matrix-doc-chip-source matrix-doc-chip-source--${doc.sourceType}`}>
            {SOURCE_TYPE_LABELS[doc.sourceType]}
          </span>
        )}
        {doc.sourceUrl ? (
          <a
            className="matrix-doc-open-source"
            href={doc.sourceUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            <ExternalLink size={12} />
            Open source
          </a>
        ) : null}
      </div>
    ));

  return (
    <div className="thread-topology-root-group">
      <span className="thread-topology-node-badge thread-topology-node-badge--system">System</span>
      <strong className="thread-topology-root-group-name">{data.name}</strong>
      {(hasContent || data.canEdit) && (
        <div className="thread-topology-root-group-docs">
          <div className="thread-topology-doc-sections">
            <div className="thread-topology-doc-section">
              <div className="thread-topology-doc-section-header">
                <span className="matrix-doc-group-label">Docs</span>
                {data.canEdit && (
                  <button
                    className="btn-icon thread-topology-doc-add"
                    type="button"
                    aria-label={`Add Document to ${data.name}`}
                    onClick={() => data.onOpenDocPicker(data.nodeId, "Document")}
                    title="Add document"
                  >
                    <Plus size={12} />
                  </button>
                )}
              </div>
              <div className="thread-topology-doc-list">
                {chunkIntoPairs(data.documents.document).map((row, rowIndex) => (
                  <div key={`root-document-row-${rowIndex}`} className="matrix-doc-row">
                    {renderChips(row, "document")}
                  </div>
                ))}
              </div>
            </div>
            <div className="thread-topology-doc-section">
              <div className="thread-topology-doc-section-header">
                <span className="matrix-doc-group-label">Skills</span>
                {data.canEdit && (
                  <button
                    className="btn-icon thread-topology-doc-add"
                    type="button"
                    aria-label={`Add Skill to ${data.name}`}
                    onClick={() => data.onOpenDocPicker(data.nodeId, "Skill")}
                    title="Add skill"
                  >
                    <Plus size={12} />
                  </button>
                )}
              </div>
              <div className="thread-topology-doc-list">
                {chunkIntoPairs(data.documents.skill).map((row, rowIndex) => (
                  <div key={`root-skill-row-${rowIndex}`} className="matrix-doc-row">
                    {renderChips(row, "skill")}
                  </div>
                ))}
              </div>
            </div>
            <div className="thread-topology-doc-section">
              <div className="thread-topology-doc-section-header">
                <span className="matrix-doc-group-label">Prompts</span>
                {data.canEdit && (
                  <button
                    className="btn-icon thread-topology-doc-add"
                    type="button"
                    aria-label={`Set system prompts for ${data.name}`}
                    onClick={openSystemPrompt}
                    title="Set system prompts"
                  >
                    <Plus size={12} />
                  </button>
                )}
              </div>
              <div className="thread-topology-doc-list">
                {hasPrompt ? (
                  chunkIntoPairs(data.systemPrompts).map((row, rowIndex) => (
                    <div key={`root-prompt-row-${rowIndex}`} className="matrix-doc-row">
                      {row.map((prompt) => (
                        <button
                          type="button"
                          className="matrix-doc-chip matrix-doc-chip--prompt"
                          key={`root-prompt-${prompt.hash}`}
                          disabled={!data.canEdit}
                          onClick={() => data.canEdit && openSystemPromptEditor(prompt)}
                        >
                          {prompt.title}
                        </button>
                      ))}
                    </div>
                  ))
                ) : null}
              </div>
            </div>
            {data.artifacts.length > 0 && (
              <div className="thread-topology-doc-section">
                <div className="thread-topology-doc-section-header">
                  <span className="matrix-doc-group-label">Artifacts</span>
                </div>
                <div className="matrix-artifacts">
                  {data.artifacts.map((artifact) => (
                    <span key={artifact.id} className="matrix-artifact-badge">
                      {artifact.type}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const FLOW_NODE_TYPES = {
  topology: TopologyFlowNode,
  rootGroup: RootGroupNode,
};

function buildFlowLayoutModel(
  nodes: TopologyNode[],
  visibleOwnerships: Set<TopologyOwnership>,
  visibleBoundaries: Set<TopologyBoundary>,
): FlowLayoutModel {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const includedNodeIds = computeVisibleTopologyNodeIds(nodes, visibleOwnerships, visibleBoundaries);
  const hiddenNodeIds = new Set<string>();
  const nestedChildrenByHost = new Map<string, TopologyNode[]>();
  const nestedKinds = new Set(["Container", "Process"]);

  // Extract Root node — rendered as a background boundary, not a regular card
  let rootNode: TopologyNode | null = null;
  for (const node of nodes) {
    if (node.kind === "Root" && includedNodeIds.has(node.id)) {
      rootNode = node;
      hiddenNodeIds.add(node.id);
      break;
    }
  }

  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!includedNodeIds.has(node.id)) continue;
    const parent = byId.get(node.parentId);
    if (!parent || parent.kind !== "Host") continue;
    if (!includedNodeIds.has(parent.id)) continue;
    if (!nestedKinds.has(node.kind)) continue;
    hiddenNodeIds.add(node.id);
    const nested = nestedChildrenByHost.get(parent.id) ?? [];
    nested.push(node);
    nestedChildrenByHost.set(parent.id, nested);
  }

  for (const nested of nestedChildrenByHost.values()) {
    nested.sort(sortNodes);
  }

  const visibleNodes = nodes.filter((node) => includedNodeIds.has(node.id) && !hiddenNodeIds.has(node.id));
  const visibleParentById = new Map<string, string | null>();
  for (const node of visibleNodes) {
    let parentId = node.parentId;
    if (node.kind === "Library") {
      parentId = null;
    }
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent) {
        parentId = null;
        break;
      }
      if (hiddenNodeIds.has(parentId) || !includedNodeIds.has(parentId)) {
        parentId = parent.parentId ?? null;
        continue;
      }
      break;
    }
    if (parentId && !byId.has(parentId)) {
      parentId = null;
    }
    visibleParentById.set(node.id, parentId);
  }

  return {
    byId,
    includedNodeIds,
    visibleNodes,
    hiddenNodeIds,
    visibleParentById,
    nestedChildrenByHost,
    rootNode,
  };
}

function computeFlowNodeDefaultPositions(model: FlowLayoutModel): Map<string, { x: number; y: number }> {
  const children = new Map<string, TopologyNode[]>();
  for (const node of model.visibleNodes) {
    const parentId = model.visibleParentById.get(node.id);
    if (!parentId) continue;
    const list = children.get(parentId) ?? [];
    list.push(node);
    children.set(parentId, list);
  }

  const depths = new Map<string, number>();
  const roots = model.visibleNodes.filter((node) => !model.visibleParentById.get(node.id)).sort(sortNodes);
  const queue: Array<{ node: TopologyNode; depth: number }> = roots.map((node) => ({ node, depth: 0 }));

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const existing = depths.get(next.node.id);
    if (typeof existing === "number" && existing <= next.depth) continue;
    depths.set(next.node.id, next.depth);

    const childNodes = (children.get(next.node.id) ?? []).sort(sortNodes);
    for (const child of childNodes) {
      queue.push({ node: child, depth: next.depth + 1 });
    }
  }

  for (const node of model.visibleNodes) {
    if (!depths.has(node.id)) {
      depths.set(node.id, 0);
    }
  }

  const columns = new Map<number, TopologyNode[]>();
  for (const node of model.visibleNodes) {
    const depth = depths.get(node.id) ?? 0;
    const list = columns.get(depth) ?? [];
    list.push(node);
    columns.set(depth, list);
  }

  const sortedColumns = Array.from(columns.entries()).sort((a, b) => a[0] - b[0]);
  const positions = new Map<string, { x: number; y: number }>();

  for (const [depth, columnNodes] of sortedColumns) {
    columnNodes.sort(sortNodes);
    columnNodes.forEach((node, index) => {
      positions.set(node.id, {
        x: depth * 320,
        y: index * 180,
      });
    });
  }

  return positions;
}

function buildFlowNodes(
  model: FlowLayoutModel,
  nodeDocuments: Map<string, MatrixDocGroup>,
  nodeArtifacts: Map<string, ArtifactRef[]>,
  onOpenDocPicker: (nodeId: string, refType: DocKind) => void,
  onOpenSystemPrompt: (nodeId: string, prompt?: SystemPromptMeta | null) => void,
  onEditDoc: (doc: MatrixCellDoc, nodeId: string, concern: string) => void,
  canEdit: boolean,
  systemPrompt: string | null,
  systemPromptTitle: string | null,
  systemPrompts: SystemPromptMeta[],
  rootBounds: RootGroupBounds | null,
): Node[] {
  const positions = computeFlowNodeDefaultPositions(model);

  const childFlowNodes = model.visibleNodes.map((node) => {
    const nestedChildren = (model.nestedChildrenByHost.get(node.id) ?? []).map((child) => ({
      id: child.id,
      name: child.name,
      kind: child.kind,
      documents: nodeDocuments.get(child.id) ?? { document: [], skill: [] },
      artifacts: nodeArtifacts.get(child.id) ?? [],
    }));
    const hasSavedPosition =
      typeof node.layoutX === "number" &&
      Number.isFinite(node.layoutX) &&
      typeof node.layoutY === "number" &&
      Number.isFinite(node.layoutY);
    const defaultPosition = positions.get(node.id) ?? { x: 0, y: 0 };

    return {
      id: node.id,
      type: "topology",
      position: hasSavedPosition ? { x: node.layoutX as number, y: node.layoutY as number } : defaultPosition,
      data: {
        nodeId: node.id,
        name: node.name,
        kind: node.kind,
        nestedChildren,
        artifacts: nodeArtifacts.get(node.id) ?? [],
        documents: nodeDocuments.get(node.id) ?? {
          document: [],
          skill: [],
        },
        canEdit,
        onOpenDocPicker,
        onEditDoc,
      },
      style: {
        borderRadius: 10,
        border: "2px solid var(--border)",
        background: "var(--bg-secondary)",
        color: "var(--fg)",
        minWidth: nestedChildren.length > 0 ? 240 : 180,
        padding: 8,
        boxShadow: "none",
      },
    };
  });

  if (model.rootNode) {
    const rootGroupNode = buildRootGroupNode(
      childFlowNodes,
      model.rootNode,
      nodeDocuments.get(model.rootNode.id) ?? { document: [], skill: [] },
      nodeArtifacts.get(model.rootNode.id) ?? [],
      canEdit,
      onOpenDocPicker,
      onOpenSystemPrompt,
      onEditDoc,
      systemPrompt,
      systemPromptTitle,
      systemPrompts,
      rootBounds,
    );
    if (rootGroupNode) {
      return [rootGroupNode, ...childFlowNodes];
    }
  }

  return childFlowNodes;
}

const ROOT_GROUP_ID = "__root_group__";
const ROOT_GROUP_PADDING_LEFT = 200;
const ROOT_GROUP_PADDING_RIGHT = 80;
const ROOT_GROUP_TOP_PADDING = 112;
const ROOT_GROUP_PADDING_BOTTOM = 80;
const ESTIMATED_NODE_WIDTH = 240;
const ESTIMATED_NODE_HEIGHT = 120;
const DEFAULT_TOPOLOGY_NODE_WIDTH = 180;

function hasFinitePosition(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resolveFlowNodeWidth(node: Node | undefined): number {
  const width =
    (typeof node?.width === "number" && Number.isFinite(node.width) ? node.width : null)
    ?? (typeof node?.style?.width === "number" && Number.isFinite(node.style.width) ? node.style.width : null)
    ?? (typeof node?.style?.minWidth === "number" && Number.isFinite(node.style.minWidth) ? node.style.minWidth : null);
  return width ?? ESTIMATED_NODE_WIDTH;
}

function resolveFlowNodeHeight(node: Node | undefined): number {
  const height =
    (typeof node?.height === "number" && Number.isFinite(node.height) ? node.height : null)
    ?? (typeof node?.style?.height === "number" && Number.isFinite(node.style.height) ? node.style.height : null)
    ?? (typeof node?.style?.minHeight === "number" && Number.isFinite(node.style.minHeight) ? node.style.minHeight : null);
  return height ?? ESTIMATED_NODE_HEIGHT;
}

function estimateFlowNodeWidth(node: TopologyNode, model: FlowLayoutModel): number {
  return (model.nestedChildrenByHost.get(node.id)?.length ?? 0) > 0 ? ESTIMATED_NODE_WIDTH : DEFAULT_TOPOLOGY_NODE_WIDTH;
}

function computeRootGroupBounds(
  model: FlowLayoutModel,
  flowNodes: Node[],
  fallbackPositions: Map<string, { x: number; y: number }>,
  cachedBounds: Map<string, { x: number; y: number; width: number; height: number }>,
): RootGroupBounds | null {
  if (model.visibleNodes.length === 0) return null;

  const liveNodesById = new Map(
    flowNodes
      .filter((node) => node.id !== ROOT_GROUP_ID)
      .map((node) => [node.id, node]),
  );

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of model.visibleNodes) {
    const liveNode = liveNodesById.get(node.id);
    const cachedNode = cachedBounds.get(node.id);
    const fallbackPosition = fallbackPositions.get(node.id) ?? { x: 0, y: 0 };
    const x = liveNode?.position.x
      ?? cachedNode?.x
      ?? (hasFinitePosition(node.layoutX) ? node.layoutX : fallbackPosition.x);
    const y = liveNode?.position.y
      ?? cachedNode?.y
      ?? (hasFinitePosition(node.layoutY) ? node.layoutY : fallbackPosition.y);
    const width = liveNode
      ? resolveFlowNodeWidth(liveNode)
      : cachedNode?.width ?? estimateFlowNodeWidth(node, model);
    const height = liveNode
      ? resolveFlowNodeHeight(liveNode)
      : cachedNode?.height ?? ESTIMATED_NODE_HEIGHT;

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  return {
    x: minX - ROOT_GROUP_PADDING_LEFT,
    y: minY - ROOT_GROUP_TOP_PADDING,
    width: maxX - minX + ROOT_GROUP_PADDING_LEFT + ROOT_GROUP_PADDING_RIGHT,
    height: maxY - minY + ROOT_GROUP_TOP_PADDING + ROOT_GROUP_PADDING_BOTTOM,
  };
}

function buildElkGraph(flowNodes: Node[], topologyEdges: TopologyEdge[], model: FlowLayoutModel): ElkNode {
  const visibleNodeIds = new Set(model.visibleNodes.map((node) => node.id));
  const flowNodeById = new Map(
    flowNodes
      .filter((node) => node.id !== ROOT_GROUP_ID)
      .map((node) => [node.id, node]),
  );

  const children: ElkNode[] = model.visibleNodes.map((node) => {
    const flowNode = flowNodeById.get(node.id);
    return {
      id: node.id,
      width: resolveFlowNodeWidth(flowNode),
      height: resolveFlowNodeHeight(flowNode),
    };
  });

  const dedupedEdges = new Set<string>();
  const edges: ElkExtendedEdge[] = [];

  for (const edge of topologyEdges) {
    const source = resolveFlowEndpoint(edge.fromNodeId, "source", model);
    const target = resolveFlowEndpoint(edge.toNodeId, "target", model);
    if (!source || !target) continue;
    if (!visibleNodeIds.has(source.nodeId) || !visibleNodeIds.has(target.nodeId)) continue;

    const edgeKey = `${source.nodeId}->${target.nodeId}`;
    if (dedupedEdges.has(edgeKey)) continue;
    dedupedEdges.add(edgeKey);

    edges.push({
      id: `elk-edge-${edges.length}`,
      sources: [source.nodeId],
      targets: [target.nodeId],
    });
  }

  return {
    id: "topology-root",
    layoutOptions: TOPOLOGY_ELK_LAYOUT_OPTIONS,
    children,
    edges,
  };
}

function applyElkPositionsToFlowNodes(layout: ElkNode, flowNodes: Node[]): AppliedElkLayout {
  const byNodeId = new Map<string, { x: number; y: number }>();
  for (const child of layout.children ?? []) {
    if (typeof child.id !== "string" || child.id.trim().length === 0) continue;
    if (typeof child.x !== "number" || !Number.isFinite(child.x)) continue;
    if (typeof child.y !== "number" || !Number.isFinite(child.y)) continue;
    byNodeId.set(child.id, { x: child.x, y: child.y });
  }

  const nodes = flowNodes.map((node) => {
    if (node.id === ROOT_GROUP_ID) return node;
    const position = byNodeId.get(node.id);
    if (!position) return node;
    return {
      ...node,
      position: { x: position.x, y: position.y },
    };
  });

  const positions = flowNodes
    .filter((node) => node.id !== ROOT_GROUP_ID)
    .map((node) => {
      const position = byNodeId.get(node.id);
      if (!position) return null;
      return { nodeId: node.id, x: position.x, y: position.y };
    })
    .filter((entry): entry is { nodeId: string; x: number; y: number } => entry !== null);

  return { nodes, positions };
}

function buildRootGroupNode(
  childNodes: Node[],
  rootNode: TopologyNode,
  documents: MatrixDocGroup,
  artifacts: ArtifactRef[],
  canEdit: boolean,
  onOpenDocPicker: (nodeId: string, refType: DocKind) => void,
  onOpenSystemPrompt: (nodeId: string, prompt?: SystemPromptMeta | null) => void,
  onEditDoc: (doc: MatrixCellDoc, nodeId: string, concern: string) => void,
  systemPrompt: string | null,
  systemPromptTitle: string | null,
  systemPrompts: SystemPromptMeta[],
  rootBounds: RootGroupBounds | null,
): Node | null {
  if (rootBounds) {
    return {
      id: ROOT_GROUP_ID,
      type: "rootGroup",
      position: { x: rootBounds.x, y: rootBounds.y },
      data: {
        name: rootNode.name,
        nodeId: rootNode.id,
        documents,
        artifacts,
        canEdit,
        onOpenDocPicker,
        onOpenSystemPrompt,
        onEditDoc,
        systemPrompt,
        systemPromptTitle,
        systemPrompts,
      },
      draggable: false,
      selectable: false,
      connectable: false,
      width: rootBounds.width,
      height: rootBounds.height,
      style: { width: rootBounds.width, height: rootBounds.height, pointerEvents: "none" as const },
      zIndex: 0,
    };
  }

  if (childNodes.length === 0) {
    const w = 400;
    const h = 200;
    return {
      id: ROOT_GROUP_ID,
      type: "rootGroup",
      position: { x: 0, y: 0 },
      data: {
        name: rootNode.name,
        nodeId: rootNode.id,
        documents,
        artifacts,
        canEdit,
        onOpenDocPicker,
        onOpenSystemPrompt,
        onEditDoc,
        systemPrompt,
        systemPromptTitle,
        systemPrompts,
      },
      draggable: false,
      selectable: false,
      connectable: false,
      width: w,
      height: h,
      style: { width: w, height: h, pointerEvents: "none" as const },
      zIndex: 0,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of childNodes) {
    const w = node.width ?? (node.style?.minWidth as number) ?? ESTIMATED_NODE_WIDTH;
    const h = node.height ?? ESTIMATED_NODE_HEIGHT;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + w);
    maxY = Math.max(maxY, node.position.y + h);
  }

  const w = maxX - minX + ROOT_GROUP_PADDING_LEFT + ROOT_GROUP_PADDING_RIGHT;
  const h = maxY - minY + ROOT_GROUP_TOP_PADDING + ROOT_GROUP_PADDING_BOTTOM;

  return {
    id: ROOT_GROUP_ID,
    type: "rootGroup",
    position: { x: minX - ROOT_GROUP_PADDING_LEFT, y: minY - ROOT_GROUP_TOP_PADDING },
    data: {
      name: rootNode.name,
      nodeId: rootNode.id,
      documents,
      artifacts,
      canEdit,
      onOpenDocPicker,
      onOpenSystemPrompt,
      onEditDoc,
      systemPrompt,
      systemPromptTitle,
      systemPrompts,
    },
    draggable: false,
    selectable: false,
    connectable: false,
    width: w,
    height: h,
    style: {
      width: w,
      height: h,
      pointerEvents: "none" as const,
    },
    zIndex: 0,
  };
}

function resolveFlowEndpoint(
  nodeId: string,
  direction: "source" | "target",
  model: FlowLayoutModel,
): FlowEndpoint | null {
  const endpoint = model.byId.get(nodeId);
  if (!endpoint) return null;
  if (!model.includedNodeIds.has(nodeId)) return null;

  if (!model.hiddenNodeIds.has(nodeId)) {
    return {
      nodeId,
      handleId: direction === "source" ? "host-out" : "host-in",
    };
  }

  let parentId = endpoint.parentId;
  while (parentId) {
    const parentNode = model.byId.get(parentId);
    if (!parentNode) break;
    if (!model.hiddenNodeIds.has(parentNode.id) && model.includedNodeIds.has(parentNode.id)) {
      return {
        nodeId: parentNode.id,
        handleId: direction === "source" ? `child-out:${endpoint.id}` : `child-in:${endpoint.id}`,
      };
    }
    parentId = parentNode.parentId;
  }

  return null;
}

function buildFlowEdges(
  edges: TopologyEdge[],
  model: FlowLayoutModel,
  showNetworkEdges: boolean,
  showDependencyEdges: boolean,
): Edge[] {
  const flowEdges: Edge[] = [];
  const visibleNodeIds = new Set(model.visibleNodes.map((node) => node.id));
  for (const edge of edges) {
    const isDependencyEdge = edge.type === "Dependency";
    const isNetworkEdge = edge.type === "Runtime" || edge.type === "Dataflow";
    if (isDependencyEdge && !showDependencyEdges) continue;
    if (isNetworkEdge && !showNetworkEdges) continue;

    const source = resolveFlowEndpoint(edge.fromNodeId, "source", model);
    const target = resolveFlowEndpoint(edge.toNodeId, "target", model);
    if (!source || !target) continue;
    if (!visibleNodeIds.has(source.nodeId) || !visibleNodeIds.has(target.nodeId)) continue;
    const layer7 = edge.layer7?.trim();
    const protocol = edge.protocol?.trim();
    const dependencyLabel = edge.type === "Dependency" ? "library" : edge.type;
    const label = layer7
      ? protocol
        ? `${layer7}\n${protocol}`
        : layer7
      : protocol || dependencyLabel;
    const edgeClassName = `thread-topology-edge ${isDependencyEdge ? "thread-topology-edge--dependency" : isNetworkEdge ? "thread-topology-edge--network" : ""}`.trim();
    const stroke = isDependencyEdge ? "var(--fg)" : "var(--fg-muted)";
    const labelFill = "var(--fg-muted)";
    const strokeDasharray = isDependencyEdge ? "6 4" : undefined;

    flowEdges.push({
      id: edge.id,
      source: source.nodeId,
      sourceHandle: source.handleId,
      target: target.nodeId,
      targetHandle: target.handleId,
      className: edgeClassName,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: {
        stroke,
        strokeWidth: 1.2,
        strokeDasharray,
      },
      label,
      labelStyle: { fill: labelFill, fontSize: 11, whiteSpace: "pre-line" },
      zIndex: 1000,
    });
  }
  return flowEdges;
}

function buildTopologyStructureSignature(nodes: TopologyNode[], edges: TopologyEdge[]): string {
  const nodeSignature = nodes
    .map((node) => `${node.id}|${node.parentId ?? ""}|${node.kind}`)
    .sort()
    .join(";");
  const edgeSignature = edges
    .map((edge) => `${edge.id}|${edge.fromNodeId}|${edge.toNodeId}|${edge.type}`)
    .sort()
    .join(";");
  return `${nodeSignature}::${edgeSignature}`;
}

export function ThreadPage({
  detail,
  threadRouteId,
  disableChatInputs = false,
  onUpdateThread,
  onSaveTopologyLayout,
  onAddMatrixDoc,
  onRemoveMatrixDoc,
  onCreateMatrixDocument,
  onReplaceMatrixDocument,
  onSendChatMessage,
  onRunAssistant,
  onCloseThread,
  onCommitThread,
  onCloneThread,
  integrationStatuses,
  assistantRunDisabledMessage,
}: ThreadPageProps) {
  const [isTopologyCollapsed, setIsTopologyCollapsed] = useState(false);
  const [isMatrixCollapsed, setIsMatrixCollapsed] = useState(true);
  const [isChatCollapsed, setIsChatCollapsed] = useState(false);
  const [isSimulationCollapsed, setIsSimulationCollapsed] = useState(false);
  const [isDescriptionEditing, setIsDescriptionEditing] = useState(false);
  const [isTitleEditing, setIsTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(detail.thread.title);
  const [titleError, setTitleError] = useState("");
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(detail.thread.description ?? "");
  const [descriptionTab, setDescriptionTab] = useState<"write" | "preview">("write");
  const [descriptionError, setDescriptionError] = useState("");
  const [isSavingDescription, setIsSavingDescription] = useState(false);
  const [visibleConcerns, setVisibleConcerns] = useState<Set<string>>(
    () => new Set(normalizeMatrixConcerns(detail.matrix.concerns).map((c) => c.name)),
  );
  const [matrixError, setMatrixError] = useState("");
  const [activeMatrixMutation, setActiveMatrixMutation] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatError, setChatError] = useState("");
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [assistantError, setAssistantError] = useState("");
  const [assistantSummaryStatus, setAssistantSummaryStatus] = useState<AssistantRunSummaryStatus | null>(null);
  const [selectedAgentModel, setSelectedAgentModel] = useState<AssistantModel>(() =>
    readStoredAssistantModel(detail.thread.id),
  );
  const [isRunningAssistant, setIsRunningAssistant] = useState(false);
  const isChatInputsDisabled = disableChatInputs;
  const [isClosingThread, setIsClosingThread] = useState(false);
  const [isCommittingThread, setIsCommittingThread] = useState(false);
  const [isCloningThread, setIsCloningThread] = useState(false);
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [showCommitModal, setShowCommitModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [commitError, setCommitError] = useState("");
  const [closeError, setCloseError] = useState("");
  const [cloneError, setCloneError] = useState("");
  const [cloneTitle, setCloneTitle] = useState(detail.thread.title);
  const [cloneDescription, setCloneDescription] = useState(detail.thread.description ?? "");
  const [pendingPlanActionId, setPendingPlanActionId] = useState<string | null>(null);
  const [showNetworkEdges, setShowNetworkEdges] = useState(true);
  const [showDependencyEdges, setShowDependencyEdges] = useState(true);
  const [visibleOwnerships, setVisibleOwnerships] = useState<Set<TopologyOwnership>>(
    () => new Set(["first_party", "third_party"]),
  );
  const [visibleBoundaries, setVisibleBoundaries] = useState<Set<TopologyBoundary>>(
    () => new Set(["internal", "external"]),
  );
  const [topologyError, setTopologyError] = useState("");
  const [isSavingTopologyLayout, setIsSavingTopologyLayout] = useState(false);
  const [isAutoLayouting, setIsAutoLayouting] = useState(false);
  const [isSimulationSuccess, setIsSimulationSuccess] = useState(false);
  const [documentModal, setDocumentModal] = useState<(MatrixDocumentModal & {
    mode: MatrixDocumentModalMode;
    selectedConcern: string;
    selectedConcerns: string[];
  }) | null>(null);
  const [docPickerSearch, setDocPickerSearch] = useState("");
  const [docPickerKindFilter, setDocPickerKindFilter] = useState<"All" | DocKind>("All");
  const [docModalMarkdownTab, setDocModalMarkdownTab] = useState<"write" | "preview">("write");
  const [docModalName, setDocModalName] = useState("");
  const [docModalTitle, setDocModalTitle] = useState("");
  const [docModalDescription, setDocModalDescription] = useState("");
  const [docModalBody, setDocModalBody] = useState("");
  const [docModalSourceType, setDocModalSourceType] = useState<DocSourceType>("local");
  const [docModalSourceUrl, setDocModalSourceUrl] = useState("");
  const [docModalValidationError, setDocModalValidationError] = useState("");
  const [docModalEditHash, setDocModalEditHash] = useState<string | null>(null);
  const [isDocumentModalBusy, setIsDocumentModalBusy] = useState(false);
  const [documentModalError, setDocumentModalError] = useState("");
  const { user } = useAuth();
  const threadDisplayId = /^\d+$/.test(threadRouteId?.trim() ?? "")
    ? threadRouteId!.trim()
    : (threadRouteId?.trim() ?? detail.thread.id).slice(0, 8);

  const sanitizeAssistantResponseText = (input: string) => {
    const noisePatterns = [
      /(?:^|\s*\|\s*)OpenShip reconciliation failed:[^\n|]*/gi,
      /(?:^|\s*\|\s*)insert or update on table "matrix_refs"[^\n|]*/gi,
      /(?:^|\s*\|\s*)violates foreign key constraint "matrix_refs_system_id_doc_hash_fkey"[^\n|]*/gi,
    ];

    let sanitized = input;
    for (const pattern of noisePatterns) {
      sanitized = sanitized.replace(pattern, "");
    }

    return sanitized
      .replace(/\s*\|\s*\|\s*/g, " | ")
      .replace(/(^|\n)\s*\|\s*/g, "$1")
      .replace(/\s*\|\s*($|\n)/g, "$1")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };

  const setAssistantRunSummary = (payload: AssistantRunResponse) => {
    const summary = getRunSummary(payload);
    setAssistantSummaryStatus(summary.status);
  };

  const updateAssistantSummary = (payload: AssistantRunResponse) => {
    setAssistantRunSummary(payload);
  };

  const clearAssistantSummary = () => {
    setAssistantSummaryStatus(null);
  };

  const isThreadOpen = detail.thread.status === "open";
  const effectiveCanEdit = detail.permissions.canEdit && isThreadOpen;
  const canCloneThread = isFinalizedThreadStatus(detail.thread.status) && detail.permissions.canEdit && !!onCloneThread;
  const isAssistantRunEnabled = onRunAssistant && !assistantRunDisabledMessage;
  const isAssistantModelSelectEnabled = isAssistantRunEnabled && !isChatInputsDisabled && !isRunningAssistant && effectiveCanEdit;

  type FullscreenTab = "topology" | "matrix" | "chat" | "simulation";
  const titleInputRef = useRef<HTMLInputElement>(null);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const reactFlowRef = useRef<ReactFlowInstance | null>(null);
  const autoLayoutInFlightRef = useRef(false);
  const pendingAutoLayoutFitViewRef = useRef(false);
  const previousTopologySignatureRef = useRef<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenTab, setFullscreenTab] = useState<FullscreenTab>("topology");

  const triggerVisibleFitViewControl = useCallback(() => {
    if (typeof document === "undefined") return false;
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".react-flow__controls-fitview"));
    if (buttons.length === 0) return false;
    const visibleButton = buttons.find((button) => button.offsetParent !== null) ?? buttons[0];
    visibleButton.click();
    return true;
  }, []);

  const scheduleTopologyFitView = useCallback(() => {
    const runFitView = () => {
      const clicked = triggerVisibleFitViewControl();
      if (clicked) return;
      reactFlowRef.current?.fitView();
    };
    const attemptDelays = [0, 140, 320];
    for (const delayMs of attemptDelays) {
      setTimeout(() => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => requestAnimationFrame(runFitView));
          return;
        }
        runFitView();
      }, delayMs);
    }
  }, [triggerVisibleFitViewControl]);

  useEffect(() => {
    if (!isTitleEditing) {
      setTitleDraft(detail.thread.title);
    }
  }, [detail.thread.title, isTitleEditing]);

  useEffect(() => {
    if (!isDescriptionEditing) {
      setDescriptionDraft(detail.thread.description ?? "");
    }
  }, [detail.thread.description, isDescriptionEditing]);

  useEffect(() => {
    if (isTitleEditing && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isTitleEditing]);

  useEffect(() => {
    const names = normalizeMatrixConcerns(detail.matrix.concerns).map((c) => c.name);
    setVisibleConcerns((prev) => {
      const nextSet = new Set<string>();
      for (const name of names) {
        if (prev.has(name)) nextSet.add(name);
      }
      return nextSet.size > 0 ? nextSet : new Set(names);
    });
  }, [detail.matrix.concerns]);

  useEffect(() => {
    setCloneTitle(detail.thread.title);
    setCloneDescription(detail.thread.description ?? "");
  }, [detail.thread.title, detail.thread.description]);

  useEffect(() => {
    setSelectedAgentModel(readStoredAssistantModel(detail.thread.id));
  }, [detail.thread.id]);

  useEffect(() => {
    setIsSimulationSuccess(false);
  }, [detail.thread.id]);

  useEffect(() => {
    if (!isAssistantModelSelectEnabled) return;
    try {
      localStorage.setItem(threadModelStorageKey(detail.thread.id), selectedAgentModel);
      localStorage.setItem(MODEL_STORAGE_KEY_GLOBAL, selectedAgentModel);
    } catch {
      // Ignore storage failures.
    }
  }, [detail.thread.id, selectedAgentModel, isAssistantModelSelectEnabled]);

  const toggleConcern = useCallback((name: string) => {
    setVisibleConcerns((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next.size > 0 ? next : prev;
    });
  }, []);

  const toggleVisibleOwnership = useCallback((ownership: TopologyOwnership) => {
    setVisibleOwnerships((prev) => {
      const next = new Set(prev);
      if (next.has(ownership)) {
        if (next.size === 1) return prev;
        next.delete(ownership);
        return next;
      }
      next.add(ownership);
      return next;
    });
  }, []);

  const toggleVisibleBoundary = useCallback((boundary: TopologyBoundary) => {
    setVisibleBoundaries((prev) => {
      const next = new Set(prev);
      if (next.has(boundary)) {
        if (next.size === 1) return prev;
        next.delete(boundary);
        return next;
      }
      next.add(boundary);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isFullscreen || documentModal) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsFullscreen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen, documentModal]);

  const nodeDocumentGroups = useMemo(() => {
    const groups = new Map<string, MatrixDocGroup>();
    const seenHashes = new Map<string, { document: Set<string>; skill: Set<string> }>();
    for (const node of detail.topology.nodes) {
      groups.set(node.id, {
        document: [],
        skill: [],
      });
      seenHashes.set(node.id, {
        document: new Set(),
        skill: new Set(),
      });
    }

    for (const cell of detail.matrix.cells) {
      const nodeGroup = groups.get(cell.nodeId);
      const nodeSeen = seenHashes.get(cell.nodeId);
      if (!nodeGroup || !nodeSeen) continue;

      for (const doc of cell.docs) {
        const key = DOC_KIND_TO_KEY[doc.refType];
        if (nodeSeen[key].has(doc.hash)) continue;
        nodeSeen[key].add(doc.hash);
        nodeGroup[key].push(doc);
      }
    }

    return groups;
  }, [detail.topology.nodes, detail.matrix.cells]);

  const nodeArtifacts = useMemo(() => {
    const artifacts = new Map<string, ArtifactRef[]>();
    for (const node of detail.topology.nodes) {
      artifacts.set(node.id, []);
    }
    const seen = new Map<string, Set<string>>();

    for (const cell of detail.matrix.cells) {
      const existing = artifacts.get(cell.nodeId);
      if (!existing) continue;
      const artifactKeys = seen.get(cell.nodeId) ?? new Set<string>();

      for (const artifact of cell.artifacts) {
        if (artifactKeys.has(artifact.id)) continue;
        artifactKeys.add(artifact.id);
        existing.push(artifact);
      }
      seen.set(cell.nodeId, artifactKeys);
    }

    return artifacts;
  }, [detail.topology.nodes, detail.matrix.cells]);

  const orderedChatMessages = useMemo(() => {
    return [...detail.chat.messages].sort((a, b) => {
      const aAction = typeof a.actionPosition === "number" ? a.actionPosition : Number.MAX_SAFE_INTEGER;
      const bAction = typeof b.actionPosition === "number" ? b.actionPosition : Number.MAX_SAFE_INTEGER;
      if (aAction !== bAction) return aAction - bAction;

      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return aTime - bTime;
      }

      return a.id.localeCompare(b.id);
    });
  }, [detail.chat.messages]);

  const visibleChatMessages = useMemo(() => {
    return orderedChatMessages.filter((message) => message.role !== "System");
  }, [orderedChatMessages]);

  const resetDocumentModal = useCallback(() => {
    setDocumentModal(null);
    setDocPickerSearch("");
    setDocPickerKindFilter("All");
    setDocModalMarkdownTab("write");
    setDocModalName("");
    setDocModalTitle("");
    setDocModalDescription("");

    setDocModalBody("");
    setDocModalSourceType("local");
    setDocModalSourceUrl("");
    setDocModalValidationError("");
    setDocModalEditHash(null);
    setDocumentModalError("");
    setIsDocumentModalBusy(false);
  }, []);

  const resolveConcernSelection = useCallback(
    (selectedConcern: string, selectedConcerns: string[]) => {
      const concerns = selectedConcerns.length > 0 ? selectedConcerns : selectedConcern ? [selectedConcern] : [];
      const concernSet = new Set(concerns);
      const uniqueConcerns = Array.from(concernSet);
      const effectiveConcern = selectedConcern || uniqueConcerns[0] || "";
      return { concerns: uniqueConcerns, effectiveConcern };
    },
    [],
  );

  // Shared modal entrypoint used by matrix-cell and topology-node add/edit actions.
  const openDocumentPicker = useCallback(
    (next: MatrixDocumentModal, mode: MatrixDocumentModalMode, editHash: string | null = null) => {
      const initialConcern = next.concern ?? "";
      const initialConcerns = next.concerns.length > 0 ? next.concerns : initialConcern ? [initialConcern] : [];
      const resolvedMode: MatrixDocumentModalMode = next.refType === "Prompt" && Boolean(editHash)
        ? "edit"
        : mode;
      setDocumentModal({
        ...next,
        selectedConcern: initialConcern,
        selectedConcerns: initialConcerns,
        mode: resolvedMode,
      });
      setDocPickerSearch("");
      setDocPickerKindFilter(next.kindFilter);
      setDocModalMarkdownTab("write");
      setDocumentModalError("");
      setDocModalValidationError("");
      setDocModalEditHash(editHash);

      if (resolvedMode === "create") {
        setDocModalName("");
        setDocModalTitle("");
        setDocModalDescription("");
    
        setDocModalBody("");
        setDocModalSourceType("local");
        setDocModalSourceUrl("");
      } else if (resolvedMode === "edit") {
        const existingDocument = detail.matrix.documents.find((doc) => doc.hash === editHash);
        if (existingDocument) {
          const parsed = parseDocumentText(existingDocument.text);
          const existingName = parsed.name && isValidDocumentName(parsed.name) ? parsed.name : "";
          setDocModalName(existingName || deriveDocumentName(existingDocument.title));
          setDocModalTitle(existingDocument.title);
          setDocModalDescription(parsed.description);

          setDocModalBody(parsed.body);
          setDocModalSourceType(existingDocument.sourceType ?? "local");
          setDocModalSourceUrl(existingDocument.sourceUrl ?? "");
          return;
        }

        if (next.refType === "Prompt" && editHash) {
          const existingPrompt = detail.systemPrompts.find((prompt) => prompt.hash === editHash);
          if (existingPrompt) {
            const parsed = parseDocumentText(existingPrompt.text);
            const existingName = parsed.name && isValidDocumentName(parsed.name) ? parsed.name : "";
            setDocModalName(existingName || deriveDocumentName(existingPrompt.title));
            setDocModalTitle(existingPrompt.title);
            setDocModalDescription(parsed.description);

            setDocModalBody(parsed.body);
            setDocModalSourceType("local");
            setDocModalSourceUrl("");
            return;
          }

          if (typeof detail.systemPrompt === "string") {
            const parsed = parseDocumentText(detail.systemPrompt);
            const fallbackName = detail.systemPromptTitle && isValidDocumentName(detail.systemPromptTitle)
              ? deriveDocumentName(detail.systemPromptTitle)
              : "";
            setDocModalName(fallbackName || "System prompt");
            setDocModalTitle(detail.systemPromptTitle || "");
            setDocModalDescription(parsed.description);

            setDocModalBody(parsed.body);
            setDocModalSourceType("local");
            setDocModalSourceUrl("");
            return;
          }
        }

        setDocModalName("");
        setDocModalTitle("");
        setDocModalDescription("");
    
        setDocModalBody("");
        setDocModalSourceType("local");
        setDocModalSourceUrl("");
      } else {
        setDocModalName("");
        setDocModalTitle("");
        setDocModalDescription("");
    
        setDocModalBody("");
        setDocModalSourceType("local");
        setDocModalSourceUrl("");
      }
      },
    [detail.matrix.documents, detail.systemPrompt, detail.systemPromptTitle, detail.systemPrompts],
  );

  const openMatrixCellDocumentPicker = useCallback(
    (nodeId: string, concern: string, refType: DocKind) => {
      openDocumentPicker(
        {
          source: "matrix-cell",
          nodeId,
          refType,
          concern,
          concerns: [concern],
          kindFilter: "All",
        },
        "browse",
      );
    },
    [openDocumentPicker],
  );

  // Topology add/edit actions are handled by the same picker modal as matrix-cell.
  const openTopologyDocumentPicker = useCallback(
    (nodeId: string, refType: DocKind) => {
      const concerns = normalizeMatrixConcerns(detail.matrix.concerns).map((entry) => entry.name);
      const matchingConcern = concerns.find((concern) =>
        normalizeConcernName(concern) === normalizeConcernName(refType),
      ) ?? concerns[0]
        ?? "";
      openDocumentPicker(
        {
          source: "topology-node",
          nodeId,
          refType,
          concern: matchingConcern,
          concerns: [],
          kindFilter: "All",
        },
        "browse",
      );
    },
    [detail.matrix.concerns, openDocumentPicker],
  );

  const openRootPromptCreator = useCallback(
    (nodeId: string, prompt?: SystemPromptMeta | null) => {
      openDocumentPicker(
        {
          source: "topology-node",
          nodeId,
          refType: "Prompt",
          concern: SYSTEM_PROMPT_CONCERN,
          concerns: [SYSTEM_PROMPT_CONCERN],
          kindFilter: "All",
        },
        prompt ? "edit" : "create",
        prompt?.hash ?? null,
      );
    },
    [openDocumentPicker],
  );

  const openEditDocumentModal = useCallback(
    (doc: MatrixCellDoc, nodeId: string, concern: string) => {
      if (!detail.matrix.documents.some((current) => current.hash === doc.hash)) return;
      openDocumentPicker(
        {
          source: "matrix-cell",
          nodeId,
          refType: doc.refType,
          concern,
          concerns: concern ? [concern] : [],
          kindFilter: "All",
        },
        "edit",
        doc.hash,
      );
    },
    [detail.matrix.documents, openDocumentPicker],
  );

  const flowLayoutModel = useMemo(
    () => buildFlowLayoutModel(detail.topology.nodes, visibleOwnerships, visibleBoundaries),
    [detail.topology.nodes, visibleOwnerships, visibleBoundaries],
  );
  const boundsLayoutModel = useMemo(
    () => buildFlowLayoutModel(detail.topology.nodes, ALL_TOPOLOGY_OWNERSHIPS, ALL_TOPOLOGY_BOUNDARIES),
    [detail.topology.nodes],
  );
  const boundsDefaultPositions = useMemo(
    () => computeFlowNodeDefaultPositions(boundsLayoutModel),
    [boundsLayoutModel],
  );
  const topologyNodeBoundsCacheRef = useRef<Map<string, { x: number; y: number; width: number; height: number }>>(new Map());
  const initialRootGroupBounds = useMemo(
    () => computeRootGroupBounds(boundsLayoutModel, [], boundsDefaultPositions, topologyNodeBoundsCacheRef.current),
    [boundsLayoutModel, boundsDefaultPositions],
  );
  const initialFlowNodes = useMemo(
    () =>
      buildFlowNodes(
        flowLayoutModel,
        nodeDocumentGroups,
        nodeArtifacts,
        openTopologyDocumentPicker,
        openRootPromptCreator,
        openEditDocumentModal,
        effectiveCanEdit,
        detail.systemPrompt,
        detail.systemPromptTitle,
        detail.systemPrompts,
        initialRootGroupBounds,
      ),
      [flowLayoutModel, nodeDocumentGroups, nodeArtifacts, openTopologyDocumentPicker, openRootPromptCreator, openEditDocumentModal, effectiveCanEdit, detail.systemPrompt, detail.systemPromptTitle, detail.systemPrompts, initialRootGroupBounds],
  );
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState(initialFlowNodes);
  const flowEdges = useMemo(
    () => buildFlowEdges(detail.topology.edges, flowLayoutModel, showNetworkEdges, showDependencyEdges),
    [detail.topology.edges, flowLayoutModel, showNetworkEdges, showDependencyEdges],
  );
  const topologyStructureSignature = useMemo(
    () => buildTopologyStructureSignature(detail.topology.nodes, detail.topology.edges),
    [detail.topology.nodes, detail.topology.edges],
  );
  const canComputeAutoLayout = flowLayoutModel.visibleNodes.length > 1;
  const canPersistAutoLayout = effectiveCanEdit && Boolean(onSaveTopologyLayout);
  const canAutoLayout = canPersistAutoLayout && canComputeAutoLayout;

  const rebuildRootGroupNodeInFlow = useCallback(
    (nodes: Node[]): Node[] => {
      if (!flowLayoutModel.rootNode) return nodes;
      const childNodes = nodes.filter((node) => node.id !== ROOT_GROUP_ID);
      const updatedRootNode = buildRootGroupNode(
        childNodes,
        flowLayoutModel.rootNode,
        nodeDocumentGroups.get(flowLayoutModel.rootNode.id) ?? { document: [], skill: [] },
        nodeArtifacts.get(flowLayoutModel.rootNode.id) ?? [],
        effectiveCanEdit,
        openTopologyDocumentPicker,
        openRootPromptCreator,
        openEditDocumentModal,
        detail.systemPrompt,
        detail.systemPromptTitle,
        detail.systemPrompts,
        computeRootGroupBounds(
          boundsLayoutModel,
          childNodes,
          boundsDefaultPositions,
          topologyNodeBoundsCacheRef.current,
        ),
      );
      if (!updatedRootNode) return nodes;
      return nodes.some((node) => node.id === ROOT_GROUP_ID)
        ? nodes.map((node) => (node.id === ROOT_GROUP_ID ? updatedRootNode : node))
        : [updatedRootNode, ...childNodes];
    },
    [flowLayoutModel.rootNode, boundsLayoutModel, boundsDefaultPositions, nodeDocumentGroups, nodeArtifacts, effectiveCanEdit, openTopologyDocumentPicker, openRootPromptCreator, openEditDocumentModal, detail.systemPrompt, detail.systemPromptTitle, detail.systemPrompts],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onFlowNodesChange(changes);
      if (!flowLayoutModel.rootNode) return;
      const needsRecalc = changes.some(
        (c) => (c.type === "position" && c.dragging) || c.type === "dimensions",
      );
      if (!needsRecalc) return;
      setFlowNodes((currentNodes) => rebuildRootGroupNodeInFlow(currentNodes));
    },
    [onFlowNodesChange, flowLayoutModel.rootNode, setFlowNodes, rebuildRootGroupNodeInFlow],
  );

  useEffect(() => {
    setFlowNodes(initialFlowNodes);
  }, [initialFlowNodes, setFlowNodes]);

  useEffect(() => {
    setFlowNodes((currentNodes) => rebuildRootGroupNodeInFlow(currentNodes));
  }, [rebuildRootGroupNodeInFlow, setFlowNodes]);

  useEffect(() => {
    const nextCache = new Map(topologyNodeBoundsCacheRef.current);
    for (const node of flowNodes) {
      if (node.id === ROOT_GROUP_ID) continue;
      nextCache.set(node.id, {
        x: node.position.x,
        y: node.position.y,
        width: resolveFlowNodeWidth(node),
        height: resolveFlowNodeHeight(node),
      });
    }
    topologyNodeBoundsCacheRef.current = nextCache;
  }, [flowNodes]);

  useEffect(() => {
    if (!pendingAutoLayoutFitViewRef.current) return;
    scheduleTopologyFitView();
    if (!isAutoLayouting && !isSavingTopologyLayout) {
      pendingAutoLayoutFitViewRef.current = false;
    }
  }, [flowNodes, isAutoLayouting, isSavingTopologyLayout, scheduleTopologyFitView]);

  const runAutoLayout = useCallback(async ({ sourceNodes, persist }: AutoLayoutRunOptions = {}) => {
    if (!canComputeAutoLayout) return;
    if (autoLayoutInFlightRef.current) return;
    autoLayoutInFlightRef.current = true;

    const nodesForLayout = sourceNodes ?? flowNodes;
    const shouldPersist = persist ?? canPersistAutoLayout;
    setTopologyError("");
    setIsAutoLayouting(true);

    try {
      const elkGraph = buildElkGraph(nodesForLayout, detail.topology.edges, flowLayoutModel);
      const laidOutGraph = await TOPOLOGY_ELK.layout(elkGraph);
      const appliedLayout = applyElkPositionsToFlowNodes(laidOutGraph, nodesForLayout);
      if (appliedLayout.positions.length === 0) {
        throw new Error("Auto layout did not return any node positions.");
      }

      const nextNodes = rebuildRootGroupNodeInFlow(appliedLayout.nodes);
      pendingAutoLayoutFitViewRef.current = true;
      setFlowNodes(nextNodes);

      if (shouldPersist && onSaveTopologyLayout) {
        setIsSavingTopologyLayout(true);
        try {
          const result = await onSaveTopologyLayout({ positions: appliedLayout.positions });
          const error = getErrorMessage(result);
          if (error) {
            setTopologyError(error);
          }
        } finally {
          setIsSavingTopologyLayout(false);
        }
      }
    } catch (error: unknown) {
      setTopologyError(error instanceof Error ? error.message : "Failed to auto layout topology.");
    } finally {
      setIsAutoLayouting(false);
      autoLayoutInFlightRef.current = false;
    }
  }, [canComputeAutoLayout, flowNodes, canPersistAutoLayout, detail.topology.edges, flowLayoutModel, rebuildRootGroupNodeInFlow, setFlowNodes, onSaveTopologyLayout, scheduleTopologyFitView]);

  useEffect(() => {
    const previous = previousTopologySignatureRef.current;
    previousTopologySignatureRef.current = topologyStructureSignature;
    if (previous === null || previous === topologyStructureSignature) return;
    void runAutoLayout({ sourceNodes: initialFlowNodes, persist: canPersistAutoLayout });
  }, [topologyStructureSignature, initialFlowNodes, canPersistAutoLayout, runAutoLayout]);

  const cellsByKey = useMemo(() => {
    const map = new Map<string, MatrixCell>();
    for (const cell of detail.matrix.cells) {
      map.set(buildMatrixCellKey(cell.nodeId, cell.concern), cell);
    }
    return map;
  }, [detail.matrix.cells]);

  const filteredConcerns = useMemo(
    () => {
      const visibleMatrixConcerns = normalizeMatrixConcerns(detail.matrix.concerns);
      return visibleMatrixConcerns.filter((c) => visibleConcerns.has(c.name));
    },
    [detail.matrix.concerns, visibleConcerns],
  );

  const visibleMatrixNodeIds = useMemo(
    () => computeVisibleTopologyNodeIds(detail.matrix.nodes, visibleOwnerships, visibleBoundaries),
    [detail.matrix.nodes, visibleOwnerships, visibleBoundaries],
  );

  const filteredMatrixNodes = useMemo(
    () => detail.matrix.nodes.filter((node) => visibleMatrixNodeIds.has(node.id)),
    [detail.matrix.nodes, visibleMatrixNodeIds],
  );

  const matrixSystemRootNode = useMemo(() => {
    const explicitRootNode = filteredMatrixNodes.find((node) => node.kind === "Root");
    if (explicitRootNode) return explicitRootNode;
    const rootCandidates = filteredMatrixNodes.filter((node) => node.parentId === null);
    return rootCandidates.length === 1 ? rootCandidates[0] : null;
  }, [filteredMatrixNodes]);

  const treeOrderedMatrixNodes = useMemo(() => {
    const childrenOf = new Map<string | null, TopologyNode[]>();
    for (const node of filteredMatrixNodes) {
      if (matrixSystemRootNode && node.id === matrixSystemRootNode.id) continue;
      const key = matrixSystemRootNode && node.parentId === matrixSystemRootNode.id
        ? null
        : node.parentId ?? null;
      const list = childrenOf.get(key) ?? [];
      list.push(node);
      childrenOf.set(key, list);
    }
    for (const list of childrenOf.values()) {
      list.sort(sortNodes);
    }
    const topLevelNodes = childrenOf.get(null);
    if (topLevelNodes) {
      topLevelNodes.sort(sortMatrixTopLevelNodes);
    }

    const result: Array<{ node: TopologyNode; depth: number }> = [];
    const visited = new Set<string>();
    const walk = (parentId: string | null, depth: number) => {
      for (const node of childrenOf.get(parentId) ?? []) {
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        result.push({ node, depth });
        walk(node.id, depth + 1);
      }
    };
    walk(null, 0);

    const remainingNodes = filteredMatrixNodes
      .filter((node) => (!matrixSystemRootNode || node.id !== matrixSystemRootNode.id) && !visited.has(node.id))
      .sort(sortNodes);
    for (const node of remainingNodes) {
      result.push({ node, depth: 0 });
      walk(node.id, 1);
    }

    return result;
  }, [filteredMatrixNodes, matrixSystemRootNode]);

  const matrixNodePathById = useMemo(() => {
    const byId = new Map(filteredMatrixNodes.map((node) => [node.id, node]));
    const paths = new Map<string, string>();

    for (const node of filteredMatrixNodes) {
      if (matrixSystemRootNode && node.id === matrixSystemRootNode.id) continue;

      const pathParts: string[] = [node.name];
      let parentId = node.parentId;
      while (parentId) {
        const parent = byId.get(parentId);
        if (!parent) break;
        if (matrixSystemRootNode && parent.id === matrixSystemRootNode.id) {
          pathParts.unshift("System");
          break;
        }
        pathParts.unshift(parent.name);
        parentId = parent.parentId;
      }

      if (matrixSystemRootNode && pathParts[0] !== "System") {
        pathParts.unshift("System");
      }

      paths.set(node.id, pathParts.join(" / "));
    }

    return paths;
  }, [filteredMatrixNodes, matrixSystemRootNode]);

  const selectedConcernsForModal = useMemo(() => {
    if (!documentModal) return [];
    if (documentModal.selectedConcerns.length > 0) return documentModal.selectedConcerns;
    if (documentModal.selectedConcern) return [documentModal.selectedConcern];
    return [];
  }, [documentModal]);

  const editedDocumentUsage = useMemo(() => {
    if (!docModalEditHash) return null;

    const nodeIds = new Set<string>();
    const categories = new Set<string>();

    for (const cell of detail.matrix.cells) {
      const refTypes = new Set<DocKind>();
      for (const doc of cell.docs) {
        if (doc.hash === docModalEditHash) {
          refTypes.add(doc.refType);
        }
      }
      if (refTypes.size === 0) continue;
      nodeIds.add(cell.nodeId);
      for (const refType of refTypes) {
        categories.add(`${cell.concern} (${refType})`);
      }
    }

    if (nodeIds.size === 0) return null;

    return {
      nodeCount: nodeIds.size,
      categories: Array.from(categories).sort(),
    };
  }, [docModalEditHash, detail.matrix.cells]);

  const addDocumentModeNodeSummary = useMemo(() => {
    if (!documentModal || documentModal.mode !== "browse") return null;
    if (!documentModal.nodeId) return null;
    if (!documentModal.refType) return null;

    const categories = new Set<string>();
    for (const cell of detail.matrix.cells) {
      if (cell.nodeId !== documentModal.nodeId) continue;
      const hasMatchingType = cell.docs.some((doc) => doc.refType === documentModal.refType);
      if (!hasMatchingType) continue;
      categories.add(cell.concern);
    }
    if (categories.size === 0) return null;

    return {
      categories: Array.from(categories).sort(),
    };
  }, [documentModal, detail.matrix.cells]);

  const editingDocumentForModal = useMemo(() => {
    const isPromptEditMode = documentModal?.refType === "Prompt" && Boolean(docModalEditHash);
    if (!documentModal || (documentModal.mode !== "edit" && !isPromptEditMode) || !docModalEditHash) return null;

    if (documentModal.refType === "Prompt") {
      const existingPrompt = detail.systemPrompts.find((prompt) => prompt.hash === docModalEditHash);
      if (!existingPrompt) return null;
      return {
        hash: existingPrompt.hash,
        title: existingPrompt.title,
        kind: "Prompt" as const,
        language: "en",
        text: existingPrompt.text,
        sourceType: "local" as DocSourceType,
        sourceUrl: null as string | null,
      };
    }

    return detail.matrix.documents.find((doc) => doc.hash === docModalEditHash && doc.kind === documentModal.refType) ?? null;
  }, [documentModal, docModalEditHash, detail.matrix.documents, detail.systemPrompts]);

  const isEditDocumentModalPristine = useMemo(() => {
    const isPromptEditMode = documentModal?.refType === "Prompt" && Boolean(docModalEditHash);
    if (!documentModal || (documentModal.mode !== "edit" && !isPromptEditMode) || !editingDocumentForModal) return false;
    const existing = editingDocumentForModal;
    const existingParsed = parseDocumentText(existing.text);
    const existingSourceType = existing.sourceType ?? "local";
    const baselineSourceUrl = existing.sourceUrl ?? "";
    const existingName = existingParsed.name && isValidDocumentName(existingParsed.name)
      ? existingParsed.name
      : deriveDocumentName(existing.title);
    const existingDescription = existingParsed.description;
    const existingBody = existingParsed.body;

    if (existingSourceType === "local") {
      return (
        docModalTitle === existing.title &&
        docModalName === existingName &&
        docModalDescription === existingDescription &&
        docModalBody === existingBody &&
        docModalSourceType === existingSourceType &&
        (docModalSourceUrl ?? "") === baselineSourceUrl
      );
    }

    return (
      docModalTitle === existing.title &&
      docModalSourceType === existingSourceType &&
      (docModalSourceUrl ?? "") === baselineSourceUrl
    );
  }, [documentModal, docModalBody, docModalDescription, docModalName, docModalSourceType, docModalSourceUrl, docModalTitle, editingDocumentForModal]);

  const availableDocs = useMemo(() => {
    if (!documentModal || documentModal.mode !== "browse") return [];

    const existingRefs = new Set(
      detail.matrix.cells
        .filter((cell) =>
          cell.nodeId === documentModal.nodeId &&
          (selectedConcernsForModal.length === 0 || selectedConcernsForModal.includes(cell.concern))
        )
        .flatMap((cell) =>
          cell.docs
            .filter((doc) =>
              documentModal.kindFilter === "All" || doc.refType === documentModal.kindFilter,
            )
            .map((doc) => `${doc.hash}:${doc.refType}`),
        )
    );
    const query = docPickerSearch.trim().toLowerCase();

    return detail.matrix.documents.filter((doc) => {
      if (existingRefs.has(`${doc.hash}:${doc.kind}`)) return false;
      if (docPickerKindFilter !== "All" && doc.kind !== docPickerKindFilter) return false;
      if (!query) return true;
      return (
        doc.title.toLowerCase().includes(query) ||
        doc.hash.toLowerCase().includes(query) ||
        doc.text.toLowerCase().includes(query)
      );
    });
  }, [selectedConcernsForModal, detail.matrix.cells, detail.matrix.documents, docPickerKindFilter, docPickerSearch, documentModal]);

  const canCloseDocumentModalWithEsc = useMemo(() => {
    if (!documentModal) return false;
    if (documentModal.mode === "edit") return isEditDocumentModalPristine;
    return true;
  }, [documentModal, isEditDocumentModalPristine]);

  useEffect(() => {
    if (!documentModal || !canCloseDocumentModalWithEsc) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      resetDocumentModal();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [documentModal, canCloseDocumentModalWithEsc, resetDocumentModal]);

  function enterFullscreen(tab: FullscreenTab) {
    setFullscreenTab(tab);
    if (!isFullscreen) {
      setIsFullscreen(true);
    }
    if (tab === "topology") {
      setTimeout(() => reactFlowRef.current?.fitView({ duration: 200 }), 50);
    }
  }

  function exitFullscreen() {
    setIsFullscreen(false);
  }

  async function handleSaveTitle() {
    if (!onUpdateThread) return;
    const normalizedTitle = titleDraft.trim();
    if (!normalizedTitle) {
      setTitleError("Title cannot be blank.");
      return;
    }
    if (normalizedTitle === detail.thread.title) {
      setIsTitleEditing(false);
      setTitleError("");
      return;
    }

    setTitleError("");
    setIsSavingTitle(true);

    try {
      const result = await onUpdateThread({ title: normalizedTitle });
      const error = getErrorMessage(result);
      if (error) {
        setTitleError(error);
        return;
      }
      setIsTitleEditing(false);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.trim()) {
        setTitleError(error.message);
      } else {
        setTitleError("Failed to save title. Please try again.");
      }
    } finally {
      setIsSavingTitle(false);
    }
  }

  async function handleSaveDescription() {
    if (!onUpdateThread) return;

    setDescriptionError("");
    setIsSavingDescription(true);

    try {
      const result = await onUpdateThread({
        description: descriptionDraft.trim() ? descriptionDraft.trim() : null,
      });

      const error = getErrorMessage(result);
      if (error) {
        setDescriptionError(error);
        return;
      }

      setIsDescriptionEditing(false);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.trim()) {
        setDescriptionError(error.message);
      } else {
        setDescriptionError("Failed to save thread description. Please try again.");
      }
    } finally {
      setIsSavingDescription(false);
    }
  }

  function switchToDocumentCreateMode() {
    if (!documentModal || !effectiveCanEdit) return;
    if (documentModal.refType === "Prompt") {
      setDocModalValidationError("Prompt is managed with a dedicated create flow.");
      return;
    }
    if (documentModal.selectedConcerns.length === 0) {
      setDocModalValidationError("Choose one or more concerns before creating.");
      return;
    }
    const { concerns, effectiveConcern } = resolveConcernSelection(
      documentModal.selectedConcern,
      documentModal.selectedConcerns,
    );
    openDocumentPicker(
      {
        source: documentModal.source,
        nodeId: documentModal.nodeId,
        refType: documentModal.refType,
        concern: effectiveConcern,
        concerns,
        kindFilter: "All",
      },
      "create",
    );
    setDocModalTitle("");
    setDocModalDescription("");
    setDocModalName("");
    setDocModalBody("");

  }

  async function handleAttachDocument(doc: MatrixDocument) {
    if (!documentModal || !onAddMatrixDoc) return;
    const { concerns, effectiveConcern } = resolveConcernSelection(
      documentModal.selectedConcern,
      documentModal.selectedConcerns,
    );

    if (concerns.length === 0) {
      setDocModalValidationError("Choose one or more concerns before attaching.");
      return;
    }
    if (!effectiveConcern) {
      setDocModalValidationError("Missing concern.");
      return;
    }

    const mutationKey = `add:${documentModal.nodeId}:${concerns.join(",")}:${doc.hash}:${doc.kind}`;
    setActiveMatrixMutation(mutationKey);
    setMatrixError("");
    setDocumentModalError("");

    const result = await onAddMatrixDoc({
      nodeId: documentModal.nodeId,
      concern: effectiveConcern,
      concerns,
      docHash: doc.hash,
      refType: doc.kind,
    });

    setActiveMatrixMutation("");
    const error = getErrorMessage(result);
    if (error) {
      setMatrixError(error);
      setDocumentModalError(error);
      return;
    }

    resetDocumentModal();
  }

  async function handleRemoveDoc(nodeId: string, concern: string, doc: MatrixCellDoc) {
    if (!onRemoveMatrixDoc) return;
    const mutationKey = `remove:${nodeId}:${concern}:${doc.hash}:${doc.refType}`;
    setActiveMatrixMutation(mutationKey);
    setMatrixError("");

    const result = await onRemoveMatrixDoc({
      nodeId,
      concern,
      docHash: doc.hash,
      refType: doc.refType,
    });

    setActiveMatrixMutation("");
    const error = getErrorMessage(result);
    if (error) {
      setMatrixError(error);
    }
  }

  async function handleCreateAndAttachDocument() {
    if (!documentModal || !onCreateMatrixDocument) return;

    const { concerns, effectiveConcern } = resolveConcernSelection(
      documentModal.selectedConcern,
      documentModal.selectedConcerns,
    );
    const isPrompt = documentModal.refType === "Prompt";

    if (isPrompt) {
      if (concerns.length !== 1 || effectiveConcern !== SYSTEM_PROMPT_CONCERN) {
        setDocModalValidationError("Prompt must be attached to the system prompt concern.");
        return;
      }
    }

    if (concerns.length === 0) {
      setDocModalValidationError("Choose one or more concerns before creating.");
      return;
    }
    if (!effectiveConcern) {
      setDocModalValidationError("Missing concern.");
      return;
    }

    const title = docModalTitle.trim();
    const name = docModalName.trim();
    const description = docModalDescription.trim();
    const language = DEFAULT_DOCUMENT_LANGUAGE;
    const body = docModalBody;
    const sourceType: DocSourceType = isPrompt ? "local" : docModalSourceType;
    const sourceUrl = docModalSourceUrl.trim();
    const sourceStatus = getIntegrationStatus(integrationStatuses, sourceType);

    if (!isIntegrationConnected(sourceType === "local" ? "connected" : sourceStatus)) {
      if (sourceType !== "local") {
        setDocModalValidationError(
          `Connect ${SOURCE_TYPE_LABELS[sourceType]} in your profile settings to continue.`,
        );
        return;
      }
    }

    if (sourceType !== "local" && !sourceUrl) {
      setDocModalValidationError(`Paste a ${SOURCE_TYPE_LABELS[sourceType]} document URL.`);
      return;
    }

    if (sourceType === "local") {
      if (!title) {
        setDocModalValidationError("Title is required.");
        return;
      }
      if (!name || !isValidDocumentName(name)) {
        setDocModalValidationError(
          "Name must be lower-case letters/numbers with dashes and no consecutive or edge dashes.",
        );
        return;
      }
    }

    const payload: MatrixDocumentCreateInput = {
      title,
      kind: documentModal.refType,
      language,
      sourceType,
      attach: {
        nodeId: documentModal.nodeId,
        concern: effectiveConcern,
        concerns,
        refType: documentModal.refType,
      },
    };
    if (sourceType === "local") {
      payload.name = name;
      payload.description = description;
      payload.body = body;
    } else {
      payload.sourceUrl = sourceUrl;
      payload.title = title || `Imported from ${SOURCE_TYPE_LABELS[sourceType]}`;
    }

    setIsDocumentModalBusy(true);
    setDocumentModalError("");
    setDocModalValidationError("");

    const result = await onCreateMatrixDocument(payload);
    setIsDocumentModalBusy(false);

    const error = getErrorMessage(result);
    if (error) {
      setDocumentModalError(error);
      return;
    }

    resetDocumentModal();
  }

  async function handleReplaceDocument() {
    if (!documentModal || !docModalEditHash || !onReplaceMatrixDocument) return;

    const isPromptEdit = documentModal.refType === "Prompt";
    const existing = isPromptEdit
      ? detail.systemPrompts.find((prompt) => prompt.hash === docModalEditHash) ?? null
      : detail.matrix.documents.find((entry) => entry.hash === docModalEditHash);
    if (!existing) {
      setDocumentModalError("Source document not found.");
      return;
    }

    const title = docModalTitle.trim();
    const name = docModalName.trim();
    const description = docModalDescription.trim();
    const body = docModalBody;
    const sourceType: DocSourceType = isPromptEdit ? "local" : ((existing as MatrixDocument).sourceType ?? "local");
    const sourceStatus = getIntegrationStatus(integrationStatuses, sourceType);
    const isRemoteDocument = sourceType !== "local";

    if (isRemoteDocument && !isIntegrationConnected(sourceStatus)) {
      setDocModalValidationError("Reconnect your source integration to edit this imported document.");
      return;
    }

    if (!isRemoteDocument && !title) {
      setDocModalValidationError("Title is required.");
      return;
    }
    if (!isRemoteDocument && (!name || !isValidDocumentName(name))) {
      setDocModalValidationError(
        "Name must be lower-case letters/numbers with dashes and no consecutive or edge dashes.",
      );
      return;
    }

    const parsed = parseDocumentText(existing.text);
    const existingTitle = existing.title;
    const next: MatrixDocumentReplaceInput = {};
    if (title !== existingTitle) next.title = title;
    if (!isRemoteDocument) {
      const nextName = name === (parsed.name || deriveDocumentName(existingTitle)) ? undefined : name;
      if (typeof nextName === "string") next.name = nextName;
      const nextDescription = description === (parsed.description || "") ? undefined : description;
      if (typeof nextDescription === "string") next.description = nextDescription;
      if (body !== parsed.body) next.body = body;
    }

    if (Object.keys(next).length === 0) {
      setDocModalValidationError("No changes to save.");
      return;
    }

    setIsDocumentModalBusy(true);
    setDocumentModalError("");
    setDocModalValidationError("");

    const result = await onReplaceMatrixDocument(docModalEditHash, next);
    setIsDocumentModalBusy(false);

    const error = getErrorMessage(result);
    if (error) {
      setDocumentModalError(error);
      return;
    }

    resetDocumentModal();
  }

  async function handleUnlinkDocument() {
    if (!documentModal || !docModalEditHash || !onRemoveMatrixDoc) return;

    const references = detail.matrix.cells.flatMap((cell) =>
      cell.docs
        .filter((doc) => doc.hash === docModalEditHash)
        .map((doc) => ({
          nodeId: cell.nodeId,
          concern: cell.concern,
          docHash: doc.hash,
          refType: doc.refType,
        })),
    );

    if (references.length === 0) {
      setDocModalValidationError("This document is not linked to any matrix cell.");
      return;
    }

    const dedupedReferences = Array.from(
      new Map(
        references.map((reference) => [
          `${reference.nodeId}::${reference.concern}::${reference.refType}`,
          reference,
        ]),
      ).values(),
    );

    setIsDocumentModalBusy(true);
    setDocumentModalError("");
    setDocModalValidationError("");
    setMatrixError("");
    setActiveMatrixMutation(`unlink:${docModalEditHash}`);

    let errorMessage = "";
    for (const reference of dedupedReferences) {
      const result = await onRemoveMatrixDoc(reference);
      const nextError = getErrorMessage(result);
      if (nextError) {
        errorMessage = nextError;
        break;
      }
    }

    setActiveMatrixMutation("");
    setIsDocumentModalBusy(false);

    if (errorMessage) {
      setDocumentModalError(errorMessage);
      return;
    }

    resetDocumentModal();
  }

  async function handleSendChat() {
    if (!onSendChatMessage || !effectiveCanEdit || !chatInput.trim() || isChatInputsDisabled) return;
    setChatError("");
    setAssistantError("");
    clearAssistantSummary();
    const prompt = chatInput.trim();

    setIsSendingChat(true);
    setIsRunningAssistant(true);

    try {
      const result = await onSendChatMessage({ content: prompt });
      const sendError = getErrorMessage(result);
      if (sendError) {
        setChatError(sendError);
        return;
      }

      const payload = (result as { messages?: ChatMessage[] } | null) ?? {};
      const userMessageId = payload.messages?.find((message) => message.role === "User")?.id ?? null;
      setPendingPlanActionId(null);
      setChatInput("");

      if (!onRunAssistant || !userMessageId) {
        if (!onRunAssistant) {
          return;
        }
        setAssistantError("Unable to queue assistant run: chat message was saved but not linked.");
        return;
      }

      const runResult = await onRunAssistant({
        chatMessageId: userMessageId,
        mode: "direct",
        planActionId: null,
        model: selectedAgentModel,
      });

      const runError = getErrorMessage(runResult);
      if (runError) {
        setAssistantError(runError);
        setAssistantSummaryStatus(null);
        return;
      }

      if (!runResult) {
        setAssistantError("No response from assistant endpoint.");
        setAssistantSummaryStatus(null);
        return;
      }

      updateAssistantSummary(runResult as AssistantRunResponse);
    } catch (error: unknown) {
      setAssistantError(error instanceof Error ? error.message : "Failed to send chat message and execute assistant.");
      setAssistantSummaryStatus(null);
    } finally {
      setIsSendingChat(false);
      setIsRunningAssistant(false);
    }
  }

  async function handleRunAssistant(mode: AssistantRunMode, planActionId: string | null = null) {
    if (!onRunAssistant || !effectiveCanEdit || !isAssistantRunEnabled || isChatInputsDisabled) return;

    setIsRunningAssistant(true);
    setAssistantError("");
    clearAssistantSummary();

    try {
      const result = await onRunAssistant({
        chatMessageId: null,
        mode,
        planActionId: mode === "direct" ? (planActionId ?? null) : null,
        model: selectedAgentModel,
      });

      const error = getErrorMessage(result);
      if (error) {
        setAssistantError(error);
        setAssistantSummaryStatus(null);
        return;
      }

      if (!result) {
        setAssistantError("No response from assistant endpoint.");
        setAssistantSummaryStatus(null);
        return;
      }

      const payload = result as AssistantRunResponse;
      if (mode === "plan" && payload.planActionId) {
        setPendingPlanActionId(payload.planActionId);
      }

      if (mode === "direct") {
        setPendingPlanActionId(null);
        updateAssistantSummary(payload);
        return;
      }

      setAssistantSummaryStatus(getRunSummary(payload).status);
    } finally {
      setIsRunningAssistant(false);
    }
  }

  const handleNodeDragStop = useCallback<NodeMouseHandler>(
    async (_event, node) => {
      if (node.type === "rootGroup") return;
      if (!effectiveCanEdit || !onSaveTopologyLayout) return;
      setTopologyError("");
      setIsSavingTopologyLayout(true);
      const result = await onSaveTopologyLayout({
        positions: [{ nodeId: node.id, x: node.position.x, y: node.position.y }],
      });
      setIsSavingTopologyLayout(false);
      const error = getErrorMessage(result);
      if (error) {
        setTopologyError(error);
      }
    },
    [effectiveCanEdit, onSaveTopologyLayout],
  );

  const handleAutoLayout = useCallback(() => {
    if (!canAutoLayout) return;
    void runAutoLayout();
  }, [canAutoLayout, runAutoLayout]);

  const renderDocumentModal = () => {
    if (!documentModal) return null;

    const fullscreenContainer = isFullscreen ? fullscreenRef.current : null;
    const isPromptModal = documentModal.refType === "Prompt";
    const hasPromptEditMode = isPromptModal && Boolean(docModalEditHash);
    const isCreateMode = documentModal.mode === "create" && !hasPromptEditMode;
    const isEditMode = documentModal.mode === "edit" || hasPromptEditMode;
    const editingDocument = isEditMode ? editingDocumentForModal : null;
    const activeSourceType = isEditMode ? (editingDocument?.sourceType ?? "local") : docModalSourceType;
    const activeSourceStatus = getIntegrationStatus(integrationStatuses, activeSourceType);
    const isRemoteSource = activeSourceType !== "local";
    const sourceConnected = isIntegrationConnected(activeSourceType === "local" ? "connected" : activeSourceStatus);
    const notionConnected = isIntegrationConnected(getIntegrationStatus(integrationStatuses, "notion"));
    const googleConnected = isIntegrationConnected(getIntegrationStatus(integrationStatuses, "google_doc"));
    const hasDisconnectedRemote = !notionConnected || !googleConnected;
    const availableSourceTypes: DocSourceType[] = ["local", "notion", "google_doc"];
    const showMarkdownFields = activeSourceType === "local";
    const isSaveDisabled =
      isDocumentModalBusy ||
      (isRemoteSource && !sourceConnected && (isCreateMode || isEditMode));
    const renderConcernPicker = () => {
      if (isPromptModal) return null;
      const visibleMatrixConcerns = normalizeMatrixConcerns(detail.matrix.concerns);
      if (visibleMatrixConcerns.length === 0) return null;
      return (
        <div className="thread-doc-concern thread-doc-concern--multi">
          <span className="field-label">Concerns</span>
          <div className="thread-doc-concern-list">
            {visibleMatrixConcerns.map((concern) => {
              const checked = documentModal.selectedConcerns.includes(concern.name);
              return (
                <label key={concern.name} className="thread-doc-concern-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setDocumentModal((current) => {
                        if (!current) return current;
                        const selectedSet = new Set(current.selectedConcerns);
                        if (checked) {
                          selectedSet.delete(concern.name);
                        } else {
                          selectedSet.add(concern.name);
                        }
                        const nextConcerns = Array.from(selectedSet);
                        return {
                          ...current,
                          concerns: nextConcerns,
                          selectedConcern: nextConcerns[0] ?? "",
                          selectedConcerns: nextConcerns,
                        };
                      });
                    }}
                  />
                  <span>{concern.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      );
    };

    const modalContent = (
      <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) resetDocumentModal(); }}>
        <div className="modal thread-doc-picker">
          <div className="thread-doc-picker-header">
            <h3 className="modal-title">
                {isCreateMode
                  ? isPromptModal
                    ? "Create Prompt"
                    : "Create Document"
                  : isEditMode
                    ? isPromptModal
                      ? "Edit Prompt"
                      : "Edit Document"
                    : "Add Document"}
            </h3>
            <button
              className="btn-icon thread-card-action"
              type="button"
              onClick={resetDocumentModal}
              aria-label="Close add document dialog"
            >
              <X size={16} />
            </button>
          </div>
          {(isEditMode && editedDocumentUsage) || (documentModal.mode === "browse" && addDocumentModeNodeSummary) ? (
            <p className="thread-doc-picker-context">
              {isEditMode && editedDocumentUsage ? (
                <>
                  This document is used by {editedDocumentUsage.nodeCount} {editedDocumentUsage.nodeCount === 1 ? "node" : "nodes"} in the
                  following categories: <strong>{editedDocumentUsage.categories.join(", ")}</strong>.
                </>
              ) : (
                <>
                  This node already has existing docs in the following categories:{" "}
                  <strong>{addDocumentModeNodeSummary?.categories.join(", ")}</strong>.
                </>
              )}
            </p>
          ) : null}
          {documentModal.mode === "browse" ? (
            <>
              <div className="thread-doc-picker-filters">
                {renderConcernPicker()}
                <input
                  className="field-input"
                  value={docPickerSearch}
                  onChange={(event) => setDocPickerSearch(event.target.value)}
                  placeholder="Search title"
                />
                <select
                  className="field-input thread-doc-kind-filter"
                  value={docPickerKindFilter}
                  onChange={(event) => {
                    const nextValue = event.target.value as "All" | DocKind;
                    setDocPickerKindFilter(nextValue);
                  }}
                >
                  <option value="All">All kinds</option>
                  {DOC_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>

              {onCreateMatrixDocument && (
                <div className="thread-inline-actions">
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={switchToDocumentCreateMode}
                    disabled={documentModal.selectedConcerns.length === 0}
                  >
                    + Create New Document
                  </button>
                </div>
              )}

              <div className="thread-doc-picker-list">
                {availableDocs.length === 0 ? (
                  <p className="matrix-empty">No documents available for this cell.</p>
                ) : (
                  availableDocs.map((doc) => {
                    const modalConcerns = documentModal.selectedConcerns.length > 0
                      ? documentModal.selectedConcerns
                      : documentModal.selectedConcern
                        ? [documentModal.selectedConcern]
                        : [];
                    const addKey = `add:${documentModal.nodeId}:${modalConcerns.join(",")}:${doc.hash}:${doc.kind}`;
                    const isDisabled = modalConcerns.length === 0;
                    const isMutating = activeMatrixMutation === addKey;
                    return (
                      <div key={doc.hash} className="thread-doc-picker-row">
                        <div>
                          <strong>{doc.title}</strong>
                          <p>{doc.kind}</p>
                        </div>
                        <button
                          className="btn"
                          type="button"
                          onClick={() => handleAttachDocument(doc)}
                          disabled={
                            isMutating || isDisabled
                          }
                        >
                          {isMutating ? "Adding..." : "Add"}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : (
            <>
              {documentModal.mode === "create" ? renderConcernPicker() : null}
              <div className="thread-doc-source">
                <div className="thread-doc-source-row">
                  <label className="field-label">Source</label>
                  <select
                    className="field-input"
                    value={activeSourceType}
                    onChange={(event) => {
                      if (!isEditMode) {
                        if (isPromptModal) return;
                        const nextSourceType = event.target.value as DocSourceType;
                        setDocModalSourceType(nextSourceType);
                        setDocModalSourceUrl("");
                      }
                    }}
                    disabled={isEditMode || isPromptModal}
                  >
                    {availableSourceTypes.map((sourceType) => {
                      const isRemote = sourceType !== "local";
                      const isConnected = !isRemote || isIntegrationConnected(getIntegrationStatus(integrationStatuses, sourceType));
                      return (
                        <option
                          key={sourceType}
                          value={sourceType}
                          disabled={isRemote && !isConnected && sourceType !== activeSourceType}
                        >
                          {SOURCE_TYPE_LABELS[sourceType]}
                        </option>
                      );
                    })}
                  </select>
                </div>
                {isRemoteSource && !sourceConnected ? (
                  <div className="thread-doc-source-status">
                    <span>{SOURCE_TYPE_LABELS[activeSourceType]} source is not connected.</span>
                    <span>
                      You can connect Notion and Google in your{" "}
                      <Link to={user?.handle ? `/${user.handle}` : "/"}>
                        profile settings
                      </Link>
                      .
                    </span>
                  </div>
                ) : null}
                {!isRemoteSource && hasDisconnectedRemote ? (
                  <div className="thread-doc-source-status thread-doc-source-status--note">
                    <span>
                      You can connect Notion and Google in your{" "}
                      <Link to={user?.handle ? `/${user.handle}` : "/"}>
                        profile settings
                      </Link>
                      .
                    </span>
                  </div>
                ) : null}

                {isRemoteSource && sourceConnected ? (
                  <div className="thread-doc-source-status thread-doc-source-status--connected">
                    <span>{SOURCE_TYPE_LABELS[activeSourceType]} is connected.</span>
                  </div>
                ) : null}
              </div>

              {isRemoteSource ? (
                <div className="field">
                  <label className="field-label">Source URL</label>
                  {isCreateMode ? (
                    <input
                      className="field-input"
                      value={docModalSourceUrl}
                      onChange={(event) => {
                        setDocModalSourceUrl(event.target.value);
                        setDocModalValidationError("");
                      }}
                      placeholder={`Paste a ${SOURCE_TYPE_LABELS[activeSourceType]} URL`}
                    />
                  ) : (
                    <div className="thread-doc-source-url">
                      <input
                        className="field-input"
                        value={editingDocument?.sourceUrl ?? docModalSourceUrl}
                        readOnly
                        aria-readonly
                      />
                      {editingDocument?.sourceUrl ? (
                        <a
                          className="matrix-doc-open-source thread-doc-source-url-link"
                          href={editingDocument.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink size={12} />
                          Open source
                        </a>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}

              <div className="thread-doc-form-fields">
                <div className="field">
                  <label className="field-label">Title</label>
                  <input
                    className="field-input"
                    value={docModalTitle}
                    onChange={(event) => {
                      setDocModalTitle(event.target.value);
                      setDocModalValidationError("");
                    }}
                  />
                </div>
                {showMarkdownFields ? (
                  <>
                    <div className="field">
                      <label className="field-label">Name</label>
                      <input
                        className="field-input"
                        value={docModalName}
                        onChange={(event) => {
                          setDocModalName(event.target.value);
                          setDocModalValidationError("");
                        }}
                        placeholder="e.g. login-sso-spec"
                      />
                    </div>
                    <div className="field">
                      <label className="field-label">Description</label>
                      <textarea
                        className="field-input field-textarea md-textarea"
                        rows={3}
                        value={docModalDescription}
                        onChange={(event) => {
                          setDocModalDescription(event.target.value);
                          setDocModalValidationError("");
                        }}
                      />
                    </div>
                    <div className="thread-doc-form-markdown">
                      <div className="md-tabs">
                        <button
                          type="button"
                          className={`md-tab${docModalMarkdownTab === "write" ? " md-tab--active" : ""}`}
                          onClick={() => setDocModalMarkdownTab("write")}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={`md-tab${docModalMarkdownTab === "preview" ? " md-tab--active" : ""}`}
                          onClick={() => setDocModalMarkdownTab("preview")}
                        >
                          View
                        </button>
                      </div>
                      {docModalMarkdownTab === "write" ? (
                        <textarea
                          className="field-input field-textarea md-textarea"
                          rows={8}
                          value={docModalBody}
                          onChange={(event) => setDocModalBody(event.target.value)}
                          placeholder="Write document markdown"
                        />
                      ) : (
                        <div className="md-preview">
                          {docModalBody.trim() ? (
                            <div
                              className="md-body"
                              dangerouslySetInnerHTML={{ __html: renderMarkdown(docModalBody) }}
                            />
                          ) : (
                            <p className="thread-description-text">Nothing to preview</p>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                ) : null}
              </div>
              {(documentModalError || docModalValidationError) && (
                <p className="field-error">{documentModalError || docModalValidationError}</p>
              )}
              <div className="thread-inline-actions">
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => {
                    if (documentModal.mode === "create") {
                      setDocumentModal((current) => (current ? { ...current, mode: "browse" } : current));
                    } else {
                      resetDocumentModal();
                    }
                  }}
                >
                  Cancel
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={documentModal.mode === "create" ? handleCreateAndAttachDocument : handleReplaceDocument}
                  disabled={isSaveDisabled}
                >
                  {isDocumentModalBusy
                    ? "Saving..."
                    : documentModal.mode === "create"
                      ? "Create"
                      : "Save changes"}
                </button>
                {documentModal.mode === "edit" && !isPromptModal && (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={handleUnlinkDocument}
                    disabled={isDocumentModalBusy}
                  >
                    {isDocumentModalBusy ? "Unlinking..." : "Unlink"}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );

    return fullscreenContainer ? createPortal(modalContent, fullscreenContainer) : modalContent;
  };

  return (
    <main className="page thread-view-page">
      <nav className="thread-view-breadcrumb">
        <Link to={`/${detail.thread.ownerHandle}/${detail.thread.projectName}`} className="page-back">
          &larr;
        </Link>
        <span className="thread-view-breadcrumb-text">
          <span className="page-title-muted">
            {detail.thread.ownerHandle} / {detail.thread.projectName}
          </span>
        </span>
      </nav>

      <div className="thread-view-title-row">
        {isTitleEditing ? (
          <div className="thread-view-title-wrap">
            <input
              ref={titleInputRef}
              className="thread-view-title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSaveTitle();
                } else if (e.key === "Escape") {
                  setIsTitleEditing(false);
                  setTitleDraft(detail.thread.title);
                  setTitleError("");
                }
              }}
              onBlur={handleSaveTitle}
              maxLength={200}
              disabled={isSavingTitle}
            />
            {titleError && <p className="field-error">{titleError}</p>}
          </div>
        ) : (
          <>
                    <h1 className="thread-view-title">
                      {detail.thread.title}{" "}
                      <span className="thread-view-title-number">#{threadDisplayId}</span>
                    </h1>
            {effectiveCanEdit && (
              <button
                className="btn btn-secondary thread-view-edit-btn"
                type="button"
                onClick={() => { setIsTitleEditing(true); setTitleError(""); }}
              >
                Edit
              </button>
            )}
          </>
        )}
      </div>

      <div className="thread-view-meta">
        <span className={`thread-status thread-status--${getThreadStatusClass(detail.thread.status)}`}>
          {getStatusLabel(detail.thread.status)}
        </span>
        <span className="thread-view-meta-text">
          <strong>{detail.thread.createdByHandle}</strong> opened this thread {timeAgo(detail.thread.createdAt)}
        </span>
      </div>

      <section className="thread-card thread-description-card">
        {effectiveCanEdit && !isDescriptionEditing && (
          <button
            className="btn-icon thread-card-action thread-description-edit"
            type="button"
            onClick={() => {
              setIsDescriptionEditing(true);
              setDescriptionTab("write");
              setDescriptionError("");
            }}
            aria-label="Edit description"
          >
            <Pencil size={16} />
          </button>
        )}

        {isDescriptionEditing ? (
          <div className="thread-description-editor">
            <div className="md-tabs">
              <button
                type="button"
                className={`md-tab${descriptionTab === "write" ? " md-tab--active" : ""}`}
                onClick={() => setDescriptionTab("write")}
              >
                Write
              </button>
              <button
                type="button"
                className={`md-tab${descriptionTab === "preview" ? " md-tab--active" : ""}`}
                onClick={() => setDescriptionTab("preview")}
              >
                Preview
              </button>
            </div>
            {descriptionTab === "write" ? (
              <textarea
                className="field-input field-textarea md-textarea"
                rows={8}
                value={descriptionDraft}
                onChange={(event) => setDescriptionDraft(event.target.value)}
                placeholder="Add a description (Markdown supported)"
              />
            ) : (
              <div className="md-preview">
                {descriptionDraft.trim() ? (
                  <div
                    className="md-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(descriptionDraft) }}
                  />
                ) : (
                  <p className="thread-description-text">Nothing to preview</p>
                )}
              </div>
            )}
            {descriptionError && <p className="field-error">{descriptionError}</p>}
            <div className="thread-inline-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  setIsDescriptionEditing(false);
                  setDescriptionDraft(detail.thread.description ?? "");
                  setDescriptionError("");
                }}
              >
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                onClick={handleSaveDescription}
                disabled={isSavingDescription}
              >
                {isSavingDescription ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : detail.thread.description ? (
          <div
            className="md-body thread-description-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.thread.description) }}
          />
        ) : (
          <p className="thread-description-text">No description provided yet.</p>
        )}
      </section>

      {(() => {
        const renderTopologyBody = () => (
          <>
            <div className="thread-topology-filters">
              <div className="thread-topology-filter-group">
                <span className="matrix-concern-filter-label">Edges</span>
                <label className={`matrix-concern-chip thread-topology-filter-chip ${showNetworkEdges ? "matrix-concern-chip--active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={showNetworkEdges}
                    onChange={() => setShowNetworkEdges((value) => !value)}
                  />
                  Network
                </label>
                <label className={`matrix-concern-chip thread-topology-filter-chip ${showDependencyEdges ? "matrix-concern-chip--active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={showDependencyEdges}
                    onChange={() => setShowDependencyEdges((value) => !value)}
                  />
                  Dependency
                </label>
              </div>
              <div className="thread-topology-filter-group">
                <span className="matrix-concern-filter-label">Ownership</span>
                <label className={`matrix-concern-chip thread-topology-filter-chip ${visibleOwnerships.has("first_party") ? "matrix-concern-chip--active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={visibleOwnerships.has("first_party")}
                    onChange={() => toggleVisibleOwnership("first_party")}
                  />
                  First-party
                </label>
                <label className={`matrix-concern-chip thread-topology-filter-chip ${visibleOwnerships.has("third_party") ? "matrix-concern-chip--active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={visibleOwnerships.has("third_party")}
                    onChange={() => toggleVisibleOwnership("third_party")}
                  />
                  Third-party
                </label>
              </div>
              <div className="thread-topology-filter-group">
                <span className="matrix-concern-filter-label">Boundary</span>
                <label className={`matrix-concern-chip thread-topology-filter-chip ${visibleBoundaries.has("internal") ? "matrix-concern-chip--active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={visibleBoundaries.has("internal")}
                    onChange={() => toggleVisibleBoundary("internal")}
                  />
                  Internal
                </label>
                <label className={`matrix-concern-chip thread-topology-filter-chip ${visibleBoundaries.has("external") ? "matrix-concern-chip--active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={visibleBoundaries.has("external")}
                    onChange={() => toggleVisibleBoundary("external")}
                  />
                  External
                </label>
              </div>
            </div>
            <div className="thread-topology-canvas">
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={FLOW_NODE_TYPES}
                onNodesChange={handleNodesChange}
                onNodeDragStop={handleNodeDragStop}
                onInit={(instance) => { reactFlowRef.current = instance; }}
                fitView
                minZoom={0.1}
                nodesDraggable={effectiveCanEdit && Boolean(onSaveTopologyLayout)}
                nodesConnectable={false}
                elementsSelectable={false}
                deleteKeyCode={null}
              >
                <Background gap={14} size={1} />
                <Controls>
                  <ControlButton
                    onClick={handleAutoLayout}
                    aria-label="Auto layout"
                    title="Auto layout"
                    disabled={!canAutoLayout || isSavingTopologyLayout || isAutoLayouting}
                  >
                    <LayoutGrid size={14} />
                  </ControlButton>
                </Controls>
              </ReactFlow>
            </div>
            {isAutoLayouting && <p className="matrix-empty">Calculating layout...</p>}
            {isSavingTopologyLayout && <p className="matrix-empty">Saving layout…</p>}
            {topologyError && <p className="field-error">{topologyError}</p>}
          </>
        );

        const renderMatrixBody = () => (
          <>
            <div className="thread-topology-filters">
              <div className="thread-topology-filter-group">
                <span className="matrix-concern-filter-label">Ownership</span>
                <label className={`matrix-concern-chip thread-topology-filter-chip ${visibleOwnerships.has("first_party") ? "matrix-concern-chip--active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={visibleOwnerships.has("first_party")}
                    onChange={() => toggleVisibleOwnership("first_party")}
                  />
                  First-party
                </label>
                <label className={`matrix-concern-chip thread-topology-filter-chip ${visibleOwnerships.has("third_party") ? "matrix-concern-chip--active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={visibleOwnerships.has("third_party")}
                    onChange={() => toggleVisibleOwnership("third_party")}
                  />
                  Third-party
                </label>
              </div>
              <div className="thread-topology-filter-group">
                <span className="matrix-concern-filter-label">Boundary</span>
                <label className={`matrix-concern-chip thread-topology-filter-chip ${visibleBoundaries.has("internal") ? "matrix-concern-chip--active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={visibleBoundaries.has("internal")}
                    onChange={() => toggleVisibleBoundary("internal")}
                  />
                  Internal
                </label>
                <label className={`matrix-concern-chip thread-topology-filter-chip ${visibleBoundaries.has("external") ? "matrix-concern-chip--active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={visibleBoundaries.has("external")}
                    onChange={() => toggleVisibleBoundary("external")}
                  />
                  External
                </label>
              </div>
            </div>
            <div className="matrix-concern-filter">
              <span className="matrix-concern-filter-label">Concerns</span>
              {normalizeMatrixConcerns(detail.matrix.concerns).map((c) => (
                <label
                  key={c.name}
                  className={`matrix-concern-chip ${visibleConcerns.has(c.name) ? "matrix-concern-chip--active" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={visibleConcerns.has(c.name)}
                    onChange={() => toggleConcern(c.name)}
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <div className="matrix-table-wrap">
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th className="matrix-node-header">Node</th>
                    {filteredConcerns.map((concern) => (
                      <th key={concern.name}>{concern.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const primaryDocType = DOC_TYPES[0] as DocKind;
                    const matrixColumnSpan = filteredConcerns.length + 1;
                    const renderMatrixConcernCells = (node: TopologyNode, displayName: string) => {
                      return filteredConcerns.map((concern) => {
                        const key = buildMatrixCellKey(node.id, concern.name);
                        const cell = cellsByKey.get(key) ?? {
                          nodeId: node.id,
                          concern: concern.name,
                          docs: [],
                          artifacts: [],
                        };

                        const isEmpty = cell.docs.length === 0 && cell.artifacts.length === 0;
                        const activeTypeCount = DOC_TYPES.filter((t) => cell.docs.some((d) => d.refType === t)).length;
                        const showLabels = activeTypeCount > 1;

                        return (
                          <td
                            key={key}
                            className={isEmpty ? "matrix-td-empty" : undefined}
                            onClick={
                              isEmpty && effectiveCanEdit
                                ? () => openMatrixCellDocumentPicker(node.id, concern.name, primaryDocType)
                                : undefined
                            }
                          >
                            <div className="matrix-cell">
                              {DOC_TYPES.map((type) => {
                                const docs = cell.docs.filter((doc) => doc.refType === type);
                                if (docs.length === 0) return null;
                                return (
                                  <div key={type} className="matrix-doc-group">
                                    {showLabels && <span className="matrix-doc-group-label">{type}</span>}
                                    <div className="matrix-doc-list">
                                      {docs.map((doc) => {
                                        return (
                                          <div
                                            key={`${doc.hash}:${doc.refType}`}
                                            className={`matrix-doc-chip matrix-doc-chip--${doc.refType.toLowerCase()} ${doc.sourceType === "notion" || doc.sourceType === "google_doc" ? "matrix-doc-chip--external" : ""}`}
                                            role={effectiveCanEdit ? "button" : undefined}
                                            tabIndex={effectiveCanEdit ? 0 : -1}
                                            onClick={() => {
                                              if (effectiveCanEdit) {
                                                openEditDocumentModal(doc, node.id, concern.name);
                                              }
                                            }}
                                            onKeyDown={(event) => {
                                              if (event.key === "Enter" || event.key === " ") {
                                                event.preventDefault();
                                                if (effectiveCanEdit) {
                                                  openEditDocumentModal(doc, node.id, concern.name);
                                                }
                                              }
                                            }}
                                          >
                                            <span>{doc.title}</span>
                                            {doc.sourceType && doc.sourceType !== "local" && (
                                              <span className={`matrix-doc-chip-source matrix-doc-chip-source--${doc.sourceType}`}>
                                                {SOURCE_TYPE_LABELS[doc.sourceType]}
                                              </span>
                                            )}
                                            {doc.sourceUrl ? (
                                              <a
                                                className="matrix-doc-open-source"
                                                href={doc.sourceUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                onClick={(event) => event.stopPropagation()}
                                              >
                                                <ExternalLink size={12} />
                                                Open source
                                              </a>
                                            ) : null}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}

                              {cell.artifacts.length > 0 && (
                                <div className="matrix-artifacts">
                                  {cell.artifacts.map((artifact) => (
                                    <span key={artifact.id} className="matrix-artifact-badge">
                                      {artifact.type}
                                    </span>
                                  ))}
                                </div>
                              )}

                              {effectiveCanEdit && (
                                <button
                                  className="matrix-add-doc-btn"
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openMatrixCellDocumentPicker(node.id, concern.name, primaryDocType);
                                  }}
                                  aria-label={`Add document to ${displayName} × ${concern.name}`}
                                >
                                  <Plus size={12} />
                                </button>
                              )}
                            </div>
                          </td>
                        );
                      });
                    };

                    const rows: ReactNode[] = [];

                    if (matrixSystemRootNode) {
                      rows.push(
                        <tr key={`${matrixSystemRootNode.id}:system-root`} className="matrix-system-root-row">
                          <th className="matrix-node-cell matrix-node-cell--system-root">
                            <div>
                              <strong>System</strong>
                              <span>{matrixSystemRootNode.kind}</span>
                            </div>
                          </th>
                          {renderMatrixConcernCells(matrixSystemRootNode, "System")}
                        </tr>,
                      );
                    }

                    for (const { node, depth } of treeOrderedMatrixNodes) {
                      const visualDepth = depth + 1;
                      const nodePath = matrixNodePathById.get(node.id);
                      const isTopLevelHost = node.kind === "Host" && depth === 0;
                      const isTopLevelLibrary = node.kind === "Library" && depth === 0;
                      const separatorClassName = isTopLevelHost || isTopLevelLibrary
                        ? "matrix-separator-row matrix-separator-row--host-break"
                        : "matrix-separator-row";
                      rows.push(
                        <tr key={`${node.id}:separator`} className={separatorClassName} aria-hidden="true">
                          <td colSpan={matrixColumnSpan} />
                        </tr>,
                      );
                      rows.push(
                        <tr key={node.id}>
                          <th className="matrix-node-cell">
                            <div className="matrix-node-row">
                              {visualDepth > 0 ? (
                                <div className="matrix-node-guides" aria-hidden="true">
                                  {Array.from({ length: visualDepth }).map((_, lineIndex) => (
                                    <span
                                      key={`${node.id}:line:${lineIndex}`}
                                      className="matrix-node-guide-line"
                                      style={{ left: `${lineIndex * 12 + 6}px` }}
                                    />
                                  ))}
                                </div>
                              ) : null}
                              <div className="matrix-node-content" style={{ paddingLeft: visualDepth * 12 + 8 }}>
                                <strong>{node.name}</strong>
                                {nodePath ? <span className="matrix-node-path">{nodePath}</span> : null}
                                <span>{node.kind}</span>
                              </div>
                            </div>
                          </th>
                          {renderMatrixConcernCells(node, node.name)}
                        </tr>,
                      );
                    }

                    return rows;
                  })()}
                </tbody>
              </table>
            </div>
            {matrixError && <p className="field-error">{matrixError}</p>}
          </>
        );

        const extractMessageTextFromUnknown = (value: unknown, depth = 0): string[] => {
          if (depth > 5 || value === null || value === undefined) return [];
          if (typeof value === "string") return [value];

          if (Array.isArray(value)) {
            return value.flatMap((item) => extractMessageTextFromUnknown(item, depth + 1));
          }

          if (typeof value === "object") {
            const typedValue = value as Record<string, unknown>;
            if (typeof typedValue.content === "string") return [typedValue.content];
            if (typeof typedValue.text === "string") return [typedValue.text];
            return Object.values(typedValue).flatMap((item) => extractMessageTextFromUnknown(item, depth + 1));
          }

          return [];
        };

        const formatChatMessageContent = (content: string) => {
          const trimmed = content.trim();
          if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return sanitizeAssistantResponseText(content);

          try {
            const parsed = JSON.parse(trimmed);
            const texts = extractMessageTextFromUnknown(parsed);
            if (texts.length > 0) {
              return sanitizeAssistantResponseText(texts.join("\n"));
            }
          } catch {
            return sanitizeAssistantResponseText(content);
          }

          return sanitizeAssistantResponseText(content);
        };

        const getChatSenderName = (message: ChatMessage) => {
          if (message.role === "User") return detail.thread.createdByHandle;
          if (message.role === "Assistant") return message.senderName ?? "Assistant";
          return message.role;
        };

        const latestAssistantMessageId = [...visibleChatMessages]
          .reverse()
          .find((message) => message.role === "Assistant")?.id ?? null;

        const renderChatBody = () => (
          <div>
            <div className="thread-chat-history">
              {visibleChatMessages.length === 0 ? (
                <p className="matrix-empty">No messages yet</p>
              ) : (
                visibleChatMessages.map((message) => (
                  <article
                    key={message.id}
                    className={`thread-chat-message thread-chat-message--${message.role.toLowerCase()}${
                      message.role === "Assistant"
                      && message.id === latestAssistantMessageId
                      && assistantSummaryStatus === "failed"
                        ? " thread-chat-message--assistant-failed"
                        : ""
                    }`}
                  >
                    <header>
                      <div className="thread-chat-message-header-left">
                        <strong>{getChatSenderName(message)}</strong>
                      </div>
                      <span>{formatDateTime(message.createdAt)}</span>
                    </header>
                    <div
                      className="thread-chat-message-body"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(formatChatMessageContent(message.content)) }}
                    />
                  </article>
                ))
              )}
            </div>

            {effectiveCanEdit ? (
              <div className="thread-chat-form">
                  <div className="thread-chat-input-row">
                    <textarea
                      className="field-input thread-chat-input"
                      rows={4}
                      placeholder="Ask AntiClodeX anything"
                      value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    disabled={isSendingChat || isChatInputsDisabled}
                  />
                  <button
                    className="thread-chat-send"
                    type="button"
                    onClick={handleSendChat}
                    disabled={isSendingChat || !chatInput.trim() || isChatInputsDisabled}
                    aria-label="Send message"
                  >
                      <Send size={14} />
                    </button>
                  </div>
                  <div className="thread-chat-model-row">
                    <select
                      id={`assistant-model-select-${detail.thread.id}`}
                      className="field-input thread-chat-agent-select"
                      aria-label="Assistant model"
                      value={selectedAgentModel}
                      onChange={(event) => setSelectedAgentModel(event.currentTarget.value as AssistantModel)}
                      disabled={!isAssistantModelSelectEnabled}
                    >
                      {ASSISTANT_MODELS.map((model) => (
                        <option key={model.key} value={model.key}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
            ) : (
              <p className="thread-chat-disabled-copy">Only owners and editors can use the chat.</p>
            )}
          </div>
        );

        const renderSimulationBody = () => (
          <div className="thread-simulation-body">
            <p className="thread-simulation-description">
              Run your simulation flow from the thread context.
            </p>
            <div className="thread-simulation-actions">
              <button
                className="btn"
                type="button"
                onClick={() => setIsSimulationSuccess(true)}
              >
                Start simulation
              </button>
              {isSimulationSuccess ? (
                <span className="thread-simulation-success">
                  <CheckCircle2 size={16} />
                  Success
                </span>
              ) : null}
            </div>
          </div>
        );

        return (
          <>
            <section className="thread-card thread-collapsible">
              <div className="thread-card-header" onClick={() => setIsTopologyCollapsed((current) => !current)}>
                <h3>Topology</h3>
                <div className="thread-card-actions">
                  <button
                    className="btn-icon thread-card-action thread-enter-fullscreen-action"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); enterFullscreen("topology"); }}
                    aria-label="Enter fullscreen topology"
                  >
                    <FullscreenIcon size={16} />
                  </button>
                  <span className="thread-card-action thread-collapse-icon" aria-hidden>
                    {isTopologyCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </span>
                </div>
              </div>

              {!isTopologyCollapsed && !isFullscreen && (
                <div className="thread-card-body">
                  {renderTopologyBody()}
                </div>
              )}
            </section>

            <section className="thread-card thread-collapsible">
              <div className="thread-card-header" onClick={() => setIsMatrixCollapsed((current) => !current)}>
                <h3>Matrix</h3>
                <div className="thread-card-actions">
                  <button
                    className="btn-icon thread-card-action thread-enter-fullscreen-action"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); enterFullscreen("matrix"); }}
                    aria-label="Enter fullscreen matrix"
                  >
                    <FullscreenIcon size={16} />
                  </button>
                  <span className="thread-card-action thread-collapse-icon" aria-hidden>
                    {isMatrixCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </span>
                </div>
              </div>

              {!isMatrixCollapsed && !isFullscreen && (
                <div className="thread-card-body">
                  {renderMatrixBody()}
                </div>
              )}
            </section>

            <section className="thread-card thread-collapsible">
              <div className="thread-card-header" onClick={() => setIsChatCollapsed((current) => !current)}>
                <h3>Chat</h3>
                <div className="thread-card-actions">
                  <button
                    className="btn-icon thread-card-action thread-enter-fullscreen-action"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); enterFullscreen("chat"); }}
                    aria-label="Enter fullscreen history"
                  >
                    <FullscreenIcon size={16} />
                  </button>
                  <span className="thread-card-action thread-collapse-icon" aria-hidden>
                    {isChatCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </span>
                </div>
              </div>

              {!isChatCollapsed && !isFullscreen && (
                <div className="thread-card-body">
                  {renderChatBody()}
                </div>
              )}
            </section>

            <section className="thread-card thread-collapsible">
              <div className="thread-card-header" onClick={() => setIsSimulationCollapsed((current) => !current)}>
                <h3>Simulation</h3>
                <div className="thread-card-actions">
                  <button
                    className="btn-icon thread-card-action thread-enter-fullscreen-action"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); enterFullscreen("simulation"); }}
                    aria-label="Enter fullscreen simulation"
                  >
                    <FullscreenIcon size={16} />
                  </button>
                  <span className="thread-card-action thread-collapse-icon" aria-hidden>
                    {isSimulationCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </span>
                </div>
              </div>

              {!isSimulationCollapsed && !isFullscreen && (
                <div className="thread-card-body">
                  {renderSimulationBody()}
                </div>
              )}
            </section>

            {canCloneThread && (
              <section className="thread-card thread-commit-card">
                <p className="thread-commit-text">
                  Create a new open thread from this finalized thread.
                </p>
                {cloneError && <p className="field-error">{cloneError}</p>}
                <button
                  className="btn"
                  type="button"
                  disabled={isCloningThread}
                  onClick={() => {
                    setCloneError("");
                    setShowCloneModal(true);
                  }}
                >
                  {isCloningThread ? "Creating…" : "New Thread"}
                </button>
              </section>
            )}

            {detail.permissions.canEdit && isThreadOpen && onCloseThread && onCommitThread && (
              <section className="thread-card thread-commit-card thread-commit-actions-card">
                <p className="thread-commit-text">
                  Finalize thread by either closing it or committing it. This action cannot be undone.
                </p>
                <div className="thread-commit-buttons">
                  <button
                    className="btn btn-secondary"
                    type="button"
                    disabled={isClosingThread || isCommittingThread}
                    onClick={() => {
                      setCloseError("");
                      setShowCloseModal(true);
                    }}
                  >
                    {isClosingThread ? "Closing…" : "Close"}
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={isClosingThread || isCommittingThread}
                    onClick={() => {
                      setCommitError("");
                      setShowCommitModal(true);
                    }}
                  >
                    {isCommittingThread ? "Committing…" : "Commit"}
                  </button>
                </div>
              </section>
            )}

            <section ref={fullscreenRef} className={isFullscreen ? "thread-fullscreen" : "thread-fullscreen-hidden"}>
              <div className="thread-fullscreen-header">
                <div className="thread-fullscreen-tabs">
                  <button
                    type="button"
                    className={`thread-fullscreen-tab${fullscreenTab === "topology" ? " thread-fullscreen-tab--active" : ""}`}
                    onClick={() => { setFullscreenTab("topology"); setTimeout(() => reactFlowRef.current?.fitView({ duration: 200 }), 50); }}
                  >
                    Topology
                  </button>
                  <button
                    type="button"
                    className={`thread-fullscreen-tab${fullscreenTab === "matrix" ? " thread-fullscreen-tab--active" : ""}`}
                    onClick={() => setFullscreenTab("matrix")}
                  >
                    Matrix
                  </button>
                  <button
                    type="button"
                    className={`thread-fullscreen-tab${fullscreenTab === "chat" ? " thread-fullscreen-tab--active" : ""}`}
                    onClick={() => setFullscreenTab("chat")}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    className={`thread-fullscreen-tab${fullscreenTab === "simulation" ? " thread-fullscreen-tab--active" : ""}`}
                    onClick={() => setFullscreenTab("simulation")}
                  >
                    Simulation
                  </button>
                </div>
                <button
                  className="btn-icon thread-card-action"
                  type="button"
                  onClick={exitFullscreen}
                  aria-label="Exit fullscreen"
                >
                  <Minimize2 size={16} />
                </button>
              </div>
              <div className="thread-fullscreen-body">
                {fullscreenTab === "topology" && renderTopologyBody()}
                {fullscreenTab === "matrix" && renderMatrixBody()}
                {fullscreenTab === "chat" && renderChatBody()}
                {fullscreenTab === "simulation" && renderSimulationBody()}
              </div>
            </section>
          </>
        );
      })()}

      {showCloseModal && onCloseThread && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !isClosingThread) setShowCloseModal(false); }}>
          <div className="modal thread-commit-modal">
            <h3 className="modal-title">Close thread</h3>
            <p className="thread-commit-modal-text">
              This will mark the thread as closed. Once closed, this action cannot be undone.
            </p>
            {closeError && <p className="field-error">{closeError}</p>}
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                type="button"
                disabled={isClosingThread}
                onClick={() => setShowCloseModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={isClosingThread}
                onClick={async () => {
                  setIsClosingThread(true);
                  setCloseError("");
                  try {
                    const result = await onCloseThread();
                    const error = getErrorMessage(result);
                    if (error) {
                      setCloseError(error);
                    } else {
                      setShowCloseModal(false);
                    }
                  } catch {
                    setCloseError("Failed to close thread");
                  } finally {
                    setIsClosingThread(false);
                  }
                }}
              >
                {isClosingThread ? "Closing…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCommitModal && onCommitThread && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !isCommittingThread) setShowCommitModal(false); }}>
          <div className="modal thread-commit-modal">
            <h3 className="modal-title">Commit thread</h3>
            <p className="thread-commit-modal-text">
              This will mark the thread as committed. Once committed, no further edits can be made.
            </p>
            {commitError && <p className="field-error">{commitError}</p>}
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                type="button"
                disabled={isCommittingThread}
                onClick={() => setShowCommitModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={isCommittingThread}
                onClick={async () => {
                  setIsCommittingThread(true);
                  setCommitError("");
                  try {
                    const result = await onCommitThread();
                    const error = getErrorMessage(result);
                    if (error) {
                      setCommitError(error);
                    } else {
                      setShowCommitModal(false);
                    }
                  } catch {
                    setCommitError("Failed to commit thread");
                  } finally {
                    setIsCommittingThread(false);
                  }
                }}
              >
                {isCommittingThread ? "Committing…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCloneModal && onCloneThread && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !isCloningThread) {
              setShowCloneModal(false);
            }
          }}
        >
          <div className="modal">
            <h3 className="modal-title">Create new thread</h3>
            <label className="field">
              <span className="field-label">Name</span>
              <input
                className="field-input"
                type="text"
                value={cloneTitle}
                onChange={(event) => setCloneTitle(event.target.value)}
                disabled={isCloningThread}
              />
            </label>
            <label className="field">
              <span className="field-label">Description</span>
              <textarea
                className="field-input field-textarea"
                rows={6}
                value={cloneDescription}
                onChange={(event) => setCloneDescription(event.target.value)}
                disabled={isCloningThread}
              />
            </label>
            {cloneError && <p className="field-error">{cloneError}</p>}
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                type="button"
                disabled={isCloningThread}
                onClick={() => setShowCloneModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={isCloningThread || !cloneTitle.trim()}
                onClick={async () => {
                  if (!cloneTitle.trim()) return;
                  setIsCloningThread(true);
                  setCloneError("");
                  try {
                    const result = await onCloneThread({
                      title: cloneTitle.trim(),
                      description: cloneDescription.trim(),
                    });
                    const error = getErrorMessage(result);
                    if (error) {
                      setCloneError(error);
                    } else {
                      setShowCloneModal(false);
                    }
                  } catch {
                    setCloneError("Failed to create thread");
                  } finally {
                    setIsCloningThread(false);
                  }
                }}
              >
                {isCloningThread ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {renderDocumentModal()}
    </main>
  );
}
