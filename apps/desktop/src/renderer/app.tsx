import { useCallback, useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AuthContext,
  useAuth,
  Header,
  Sidebar,
  Home,
  ProjectPage,
  ProjectSettingsPage,
  ThreadPage,
  SettingsPage,
  UserProfilePage,
  setNavigate,
  type AuthUser,
  type AssistantRunResponse,
  type UserProfile,
  type ChatMessage,
  type MatrixDocument,
  type MatrixCell,
  type MatrixCellDoc,
  type Project,
  type IntegrationProvider,
  type IntegrationConnectionStatus,
  type IntegrationStatusRecord,
  type ThreadDetail,
  type ThreadDetailPayload,
  type Collaborator,
  type Concern,
  type SearchResult,
} from "@acx/ui";

function normalizeApiUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "http://localhost:3001/v1";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function isNumericThreadRouteId(threadId: string): boolean {
  return /^\d+$/.test(threadId.trim());
}

function appendProjectScope(path: string, projectId: string | null): string {
  if (!projectId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}projectId=${encodeURIComponent(projectId)}`;
}

const API_URL = normalizeApiUrl(import.meta.env.VITE_API_URL ?? "http://localhost:3001");

interface V1ProjectListItem {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  accessRole: string;
  ownerHandle: string;
  createdAt: string;
  threads?: Array<{
    id: string;
    title: string | null;
    description: string | null;
    projectThreadId?: number | null;
    status: "open" | "closed" | "committed";
    sourceThreadId?: string | null;
    updatedAt: string;
    createdAt?: string;
  }>;
  threadCount?: number;
}

interface V1ProjectListResponse {
  items: V1ProjectListItem[];
  page?: number;
  pageSize?: number;
  nextCursor?: string | null;
}

interface V1ThreadListItem {
  id: string;
  projectId: string;
  projectThreadId: number | null;
  sourceThreadId: string | null;
  title: string | null;
  description: string | null;
  status: "open" | "closed" | "committed";
  createdAt: string;
  updatedAt: string;
  accessRole: string;
}

interface V1ThreadListResponse {
  items: V1ThreadListItem[];
  page?: number;
  pageSize?: number;
  nextCursor?: string | null;
}

interface V1ProjectSettingsPayload {
  accessRole: string;
  visibility: "public" | "private";
  projectRoles: string[];
  concerns: Concern[];
  collaborators: Collaborator[];
}

interface V1RunStartResponse {
  runId?: string;
  status?: "queued" | "running" | "success" | "failed" | "cancelled";
  mode?: "direct" | "plan";
  threadId?: string;
  systemId?: string;
}

interface V1EventItem {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  traceId: string | null;
  payload: Record<string, unknown>;
  version: number;
}

interface V1ParsedSSEPacket {
  type: string;
  id: string | null;
  data: string;
}

function parseSSEPackets(buffer: string): {
  packets: V1ParsedSSEPacket[];
  remainder: string;
} {
  const chunks = buffer.split("\n\n");
  const remainder = chunks.pop() ?? "";
  const packets = chunks
    .map((chunk) => {
      const lines = chunk.split("\n");
      let type = "message";
      let id: string | null = null;
      const payloadLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          type = line.slice(6).trim() || "message";
          continue;
        }
        if (line.startsWith("id:")) {
          id = line.slice(3).trim() || null;
          continue;
        }
        if (line.startsWith("data:")) {
          payloadLines.push(line.slice(5));
        }
      }

      const data = payloadLines.join("\n").trim();
      if (!data) return null;
      return { type, id, data };
    })
    .filter((packet): packet is V1ParsedSSEPacket => packet !== null);

  return { packets, remainder };
}

function eventCursorFromItem(event: V1EventItem): string {
  return `${encodeURIComponent(event.occurredAt)}|${encodeURIComponent(event.id)}`;
}

function extractThreadIdFromEventPayload(event: V1EventItem): string | null {
  const candidate = event.payload?.threadId;
  return typeof candidate === "string" ? candidate : null;
}

function isThreadEvent(event: V1EventItem, threadId: string): boolean {
  if (event.aggregateType === "thread" && event.aggregateId === threadId) return true;
  return extractThreadIdFromEventPayload(event) === threadId;
}

function normalizeProject(item: V1ProjectListItem): Project {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    accessRole: item.accessRole,
    visibility: item.visibility,
    ownerHandle: item.ownerHandle,
    createdAt: item.createdAt,
    threads: item.threads?.map((thread) => ({
      id: thread.id,
      projectThreadId: thread.projectThreadId,
      title: thread.title,
      description: thread.description,
      status: thread.status,
      sourceThreadId: thread.sourceThreadId,
      updatedAt: thread.updatedAt,
      createdAt: thread.createdAt,
    })) ?? [],
  };
}

function normalizeThread(row: V1ThreadListItem): {
  id: string;
  title: string | null;
  description: string | null;
  projectThreadId?: number | null;
  status: "open" | "closed" | "committed";
  sourceThreadId?: string | null;
  updatedAt: string;
  createdAt: string;
} {
  return {
    id: row.id,
    projectThreadId: row.projectThreadId,
    title: row.title,
    description: row.description,
    status: row.status,
    sourceThreadId: row.sourceThreadId,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

function toThreadDetailFromSummary(
  row: {
    id: string;
    title: string | null;
    description: string | null;
    status: "open" | "closed" | "committed";
    createdAt?: string;
    createdByHandle?: string;
    ownerHandle?: string;
    projectName?: string;
    accessRole?: string;
  },
  project: V1ProjectListItem,
): ThreadDetail {
  return {
    id: row.id,
    title: row.title ?? "Thread",
    description: row.description,
    status: row.status,
    createdAt: row.createdAt ?? new Date().toISOString(),
    createdByHandle: row.createdByHandle ?? project.ownerHandle,
    ownerHandle: row.ownerHandle ?? project.ownerHandle,
    projectName: row.projectName ?? project.name,
    accessRole: row.accessRole ?? project.accessRole,
  };
}

async function resolveProject(
  apiFetch: ReturnType<typeof useApi>,
  handle: string,
  projectName: string,
): Promise<V1ProjectListItem | null> {
  const projectsRes = await apiFetch("/projects");
  if (!projectsRes.ok) return null;
  const projectsData = await projectsRes.json() as V1ProjectListResponse;
  return (
    projectsData.items.find((project) => project.ownerHandle === handle && project.name === projectName) ??
    null
  );
}

function toEnvelopePayload<T>(raw: {
  items?: T[];
  page?: number;
  pageSize?: number;
  nextCursor?: string | null;
}): {
  items: T[];
  page: number;
  pageSize: number;
  nextCursor: string | null;
} {
  return {
    items: raw.items ?? [],
    page: raw.page ?? 1,
    pageSize: raw.pageSize ?? 50,
    nextCursor: raw.nextCursor ?? null,
  };
}

interface ElectronAuthAPI {
  getState: () => Promise<{ isAuthenticated: boolean }>;
  getValidAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  login: () => void;
  logout: () => void;
  onStateChanged: (cb: (state: { isAuthenticated: boolean }) => void) => () => void;
}

interface AssistantRunResultResponse {
  error?: string;
  runId: string;
  status?: "queued" | "running" | "success" | "failed";
  systemId?: string;
  planActionId?: string | null;
  planResponseActionId?: string | null;
  executeActionId?: string | null;
  executeResponseActionId?: string | null;
  updateActionId?: string | null;
  filesChanged?: Array<{
    kind: "Create" | "Update" | "Delete";
    path: string;
    fromHash?: string;
    toHash?: string;
  }>;
  summary?: {
    status: "success" | "failed";
    messages: string[];
  };
  changesCount?: number;
  messages?: Array<{
    id: string;
    actionId: string;
    role: "User" | "Assistant" | "System";
    actionType: string;
    actionPosition: number;
    content: string;
    senderName?: string;
    createdAt: string;
  }>;
  threadState?: ThreadDetailPayload;
  systemIdPrompt?: string;
}

interface ElectronAssistantAPI {
  run: (payload: {
    handle: string;
    projectName: string;
    threadId: string;
    projectId?: string;
    runId: string;
  }) => Promise<AssistantRunResultResponse>;
}

declare global {
  interface Window {
    electronAPI: {
      platform: string;
      auth: ElectronAuthAPI;
      assistant?: ElectronAssistantAPI;
    };
  }
}

function upsertMatrixCell(cells: MatrixCell[], nextCell: MatrixCell): MatrixCell[] {
  const index = cells.findIndex(
    (cell) => cell.nodeId === nextCell.nodeId && cell.concern === nextCell.concern,
  );
  if (index === -1) return [...cells, nextCell];
  return cells.map((cell, idx) => (idx === index ? nextCell : cell));
}

function upsertMatrixDocument(documents: MatrixDocument[], next: MatrixDocument): MatrixDocument[] {
  const index = documents.findIndex((document) => document.hash === next.hash);
  if (index === -1) return [...documents, next];
  return documents.map((document, idx) =>
    idx === index
      ? {
          ...document,
          title: next.title,
          kind: next.kind,
          language: next.language,
          text: next.text,
          sourceType: next.sourceType,
          sourceUrl: next.sourceUrl,
          sourceExternalId: next.sourceExternalId,
          sourceMetadata: next.sourceMetadata,
          sourceConnectedUserId: next.sourceConnectedUserId,
        }
      : document,
  );
}

function replaceMatrixDocumentReferences(
  cells: MatrixCell[],
  oldHash: string,
  nextDoc: MatrixDocument,
): MatrixCell[] {
  return cells.map((cell) => ({
    ...cell,
    docs: cell.docs.map((doc) =>
      doc.hash === oldHash
        ? {
            ...doc,
            hash: nextDoc.hash,
            title: nextDoc.title,
            kind: nextDoc.kind,
            language: nextDoc.language,
            sourceType: nextDoc.sourceType,
            sourceUrl: nextDoc.sourceUrl,
            sourceExternalId: nextDoc.sourceExternalId,
            sourceMetadata: nextDoc.sourceMetadata,
            sourceConnectedUserId: nextDoc.sourceConnectedUserId,
          }
        : doc,
    ),
  }));
}

function replaceMatrixDocumentInGlobalList(
  documents: MatrixDocument[],
  oldHash: string,
  nextDoc: MatrixDocument,
): MatrixDocument[] {
  const withoutOld = documents.filter((document) => document.hash !== oldHash);
  if (withoutOld.some((document) => document.hash === nextDoc.hash)) return withoutOld;
  return [...withoutOld, nextDoc];
}

type MatrixRefMutationResponse = {
  systemId: string;
  cell?: MatrixCell;
  cells?: MatrixCell[];
  messages?: ChatMessage[];
  systemPrompt?: string | null;
  systemPromptTitle?: string | null;
  systemPrompts?: Array<{
    hash: string;
    title: string;
    text: string;
  }>;
};

interface MatrixRefInput {
  nodeId: string;
  concern: string;
  concerns?: string[];
  docHash: string;
  refType: "Document" | "Skill" | "Prompt";
}

interface MatrixDocumentCreateInput {
  title: string;
  kind: "Document" | "Skill" | "Prompt";
  language: string;
  sourceType: "local" | "notion" | "google_doc";
  sourceUrl?: string;
  name?: string;
  description?: string;
  body?: string;
  attach?: {
    nodeId: string;
    concern?: string;
    concerns?: string[];
    refType: "Document" | "Skill" | "Prompt";
  };
}

interface MatrixDocumentCreateResponse {
  systemId: string;
  document: MatrixDocument;
  cell?: MatrixCell;
  cells?: MatrixCell[];
  messages?: ChatMessage[];
  systemPrompt?: string | null;
  systemPromptTitle?: string | null;
  systemPrompts?: Array<{
    hash: string;
    title: string;
    text: string;
  }>;
}

interface MatrixDocumentReplaceInput {
  title?: string;
  name?: string;
  description?: string;
  language?: string;
  body?: string;
}

interface MatrixDocumentReplaceResponse {
  systemId: string;
  oldHash: string;
  document: MatrixDocument;
  replacedRefs: number;
  messages?: ChatMessage[];
  systemPrompt?: string | null;
  systemPromptTitle?: string | null;
  systemPrompts?: Array<{
    hash: string;
    title: string;
    text: string;
  }>;
}

function normalizeMutationCells(response: MatrixRefMutationResponse): MatrixCell[] {
  const cells = response.cells?.length ? response.cells : response.cell ? [response.cell] : [];
  return cells.filter((cell): cell is MatrixCell => Boolean(cell.nodeId && cell.concern));
}

function applyMutationCells(
  currentCells: MatrixCell[],
  nextCells: MatrixCell[],
): MatrixCell[] {
  return nextCells.reduce((cells, nextCell) => upsertMatrixCell(cells, nextCell), currentCells);
}

function getAttachConcerns(
  payload?: {
    concern?: string;
    concerns?: string[];
  },
): string[] {
  const concernsFromList = Array.isArray(payload?.concerns)
    ? payload.concerns.map((concern) => concern.trim()).filter(Boolean)
    : [];
  const uniqueConcerns = Array.from(new Set(concernsFromList));
  if (uniqueConcerns.length > 0) return uniqueConcerns;
  const concern = payload?.concern?.trim();
  return concern ? [concern] : [];
}

function buildFallbackAttachedCells(
  existingCells: MatrixCell[],
  nodeId: string,
  concerns: string[],
  refType: "Document" | "Skill",
  document: MatrixDocument,
): MatrixCell[] {
  return concerns.map((concern) => {
    const existingCell = existingCells.find((cell) => cell.nodeId === nodeId && cell.concern === concern);
    const nextDoc: MatrixCellDoc = {
      hash: document.hash,
      title: document.title,
      kind: document.kind,
      language: document.language,
      refType,
      sourceType: document.sourceType,
      sourceUrl: document.sourceUrl,
      sourceExternalId: document.sourceExternalId,
      sourceMetadata: document.sourceMetadata,
      sourceConnectedUserId: document.sourceConnectedUserId,
    };

    const docs = existingCell ? existingCell.docs : [];
    const hasDoc = docs.some((entry) => entry.hash === nextDoc.hash && entry.refType === nextDoc.refType);
    const nextDocs = hasDoc ? docs : [...docs, nextDoc];

    return {
      nodeId,
      concern,
      docs: nextDocs,
      artifacts: existingCell?.artifacts ?? [],
    };
  });
}

function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const existing = new Set(current.map((message) => message.id));
  const next = incoming.filter((message) => !existing.has(message.id));
  return [...current, ...next];
}

function applyMatrixMutationResponse(
  detail: ThreadDetailPayload,
  response: MatrixRefMutationResponse,
): ThreadDetailPayload {
  const nextCells = normalizeMutationCells(response);
  return {
    ...detail,
    systemId: response.systemId,
    matrix: nextCells.length === 0
      ? detail.matrix
      : {
          ...detail.matrix,
          cells: applyMutationCells(detail.matrix.cells, nextCells),
        },
    chat: {
      ...detail.chat,
      messages: mergeChatMessages(detail.chat.messages, response.messages ?? []),
    },
    ...(response.systemPrompt === undefined
      ? {}
      : {
          systemPrompt: response.systemPrompt ?? null,
          systemPromptTitle: response.systemPromptTitle ?? null,
          systemPrompts: response.systemPrompts ?? [],
        }),
  };
}

function applyTopologyPositions(
  detail: ThreadDetailPayload,
  positions: Array<{ nodeId: string; x: number; y: number }>,
): ThreadDetailPayload {
  const byNodeId = new Map(positions.map((position) => [position.nodeId, position]));
  return {
    ...detail,
    topology: {
      ...detail.topology,
      nodes: detail.topology.nodes.map((node) => {
        const position = byNodeId.get(node.id);
        if (!position) return node;
        return { ...node, layoutX: position.x, layoutY: position.y };
      }),
    },
    matrix: {
      ...detail.matrix,
      nodes: detail.matrix.nodes.map((node) => {
        const position = byNodeId.get(node.id);
        if (!position) return node;
        return { ...node, layoutX: position.x, layoutY: position.y };
      }),
    },
  };
}

function mergeThreadStateFromRun(
  detail: ThreadDetailPayload,
  threadState?: ThreadDetailPayload,
): ThreadDetailPayload {
  if (!threadState) return detail;
  return {
    ...detail,
    systemId: threadState.systemId,
    topology: threadState.topology,
    matrix: threadState.matrix,
    systemPrompt: threadState.systemPrompt,
    systemPromptTitle: threadState.systemPromptTitle,
    systemPrompts: threadState.systemPrompts,
  };
}

async function readError(res: Response, fallback: string) {
  const body = await res.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title : null;
  const detail = typeof body.detail === "string" ? body.detail : null;
  if (title && detail) {
    return `${title}: ${detail}`;
  }

  if (typeof body.code === "string" && body.code === "INTEGRATION_RECONNECT") {
    const provider = typeof body.provider === "string" ? body.provider : null;
    const status = typeof body.status === "string" ? body.status : null;
    if (provider) {
      return `${body.error ?? "Reauthentication required"} (${provider}${
        status ? ` - ${status}` : ""
      })`;
    }
  }
  if (typeof body.error === "string" && body.error) return body.error;
  return fallback;
}

async function desktopApiFetch(path: string, init?: RequestInit): Promise<Response> {
  const request = async (forceRefresh = false) => {
    const token = await window.electronAPI.auth.getValidAccessToken({ forceRefresh });
    if (!token) throw new Error("Not authenticated");

    const headers = new Headers(init?.headers ?? {});
    headers.set("Authorization", `Bearer ${token}`);

    return fetch(`${API_URL}${path}`, {
      ...init,
      headers,
    });
  };

  let response = await request();
  if (response.status === 401) {
    response = await request(true);
    if (response.status === 401) {
      window.electronAPI.auth.logout();
    }
  }

  return response;
}

function useApi() {
  const apiFetch = useCallback(
    async (path: string, init?: RequestInit) => desktopApiFetch(path, init),
    [],
  );

  return apiFetch;
}

function NavigateSync() {
  const navigate = useNavigate();

  useEffect(() => {
    setNavigate((to) => navigate(to));
  }, [navigate]);

  return null;
}

function HomeRoute({
  projects,
  setProjects,
}: {
  projects: Project[];
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
}) {
  const apiFetch = useApi();

  return (
    <Home
      projects={projects}
      onCheckProjectName={async (name) => {
        try {
          const res = await apiFetch(`/projects/check-name?name=${encodeURIComponent(name)}`);
          if (!res.ok) return true;
          const data = await res.json();
          return data.available;
        } catch {
          return true;
        }
      }}
      onCreateProject={async (data) => {
        try {
          const res = await apiFetch("/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return { error: body.error ?? "Failed to create project" };
          }
          const project = normalizeProject(await res.json());
          setProjects((prev) => [project, ...prev]);
        } catch (error) {
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
          return { error: "Failed to create project" };
        }
      }}
    />
  );
}

function ProfileRoute({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { handle } = useParams<{ handle: string }>();
  const apiFetch = useApi();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !handle) return;

    setNotFound(false);
    setProfile(null);

    apiFetch(`/users/${encodeURIComponent(handle)}`)
      .then(async (res) => {
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        setProfile(await res.json());
      })
      .catch(() => setNotFound(true));
  }, [isAuthenticated, handle, apiFetch]);

  if (notFound) {
    return (
      <main className="main">
        <p className="status-text">User not found</p>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="main">
        <p className="status-text">Loading…</p>
      </main>
    );
  }

  return (
    <UserProfilePage profile={profile} />
  );
}

function AccountSettingsRoute({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { isLoading } = useAuth();
  const apiFetch = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const [integrationStatuses, setIntegrationStatuses] = useState<IntegrationStatusRecord>({
    notion: "disconnected",
    google: "disconnected",
  });

  const refreshIntegrationStatuses = useCallback(async () => {
    const nextStatuses: IntegrationStatusRecord = {
      notion: "disconnected",
      google: "disconnected",
    };
    await Promise.all(
      (["notion", "google"] as IntegrationProvider[]).map(async (provider) => {
        try {
          const res = await apiFetch(`/integrations/${provider}/status`);
          if (!res.ok) return;
          const data = (await res.json()) as { status: IntegrationStatusRecord[IntegrationProvider] };
          nextStatuses[provider] = data.status;
        } catch {
          // Keep disconnected fallback.
        }
      }),
    );
    setIntegrationStatuses(nextStatuses);
  }, [apiFetch]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refreshIntegrationStatuses();
  }, [isAuthenticated, refreshIntegrationStatuses]);

  useEffect(() => {
    const provider = searchParams.get("integration");
    const status = searchParams.get("integration_status");
    if (!provider || !status) return;
    if (isAuthenticated) {
      void refreshIntegrationStatuses();
    }
    setSearchParams((params) => {
      params.delete("integration");
      params.delete("integration_status");
      return params;
    }, { replace: true });
  }, [isAuthenticated, refreshIntegrationStatuses, searchParams, setSearchParams]);

  if (!isAuthenticated) {
    return (
      <main className="main">
        <p className="status-text">Sign in to access settings.</p>
      </main>
    );
  }

  if (isLoading) {
    return (
      <main className="main">
        <p className="status-text">Loading…</p>
      </main>
    );
  }

  return (
    <SettingsPage
      returnTo="/settings"
      integrationStatuses={integrationStatuses}
      onConnectIntegration={async (provider, returnTo) => {
        try {
          const res = await apiFetch(
            `/integrations/${provider}/authorize-url?returnTo=${encodeURIComponent(returnTo)}`,
          );
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return { error: body.error ?? `Failed to connect ${provider}` };
          }
          const data = (await res.json()) as { url?: string };
          if (!data.url) {
            return { error: `Failed to retrieve ${provider} authorization URL` };
          }
          window.location.assign(data.url);
          return { status: "connected" };
        } catch {
          return { error: `Failed to connect ${provider}` };
        }
      }}
      onDisconnectIntegration={async (provider) => {
        try {
          const res = await apiFetch(`/integrations/${provider}/disconnect`, { method: "POST" });
          if (!res.ok) {
            return { error: await readError(res, `Failed to disconnect ${provider}`) };
          }
          const data = (await res
            .json()
            .catch(() => ({ status: "disconnected" as IntegrationConnectionStatus }))) as {
            status: IntegrationConnectionStatus;
          };
          await refreshIntegrationStatuses();
          return data;
        } catch {
          return { error: `Failed to disconnect ${provider}` };
        }
      }}
    />
  );
}

function ProjectRoute({ isAuthenticated, onProjectMutated }: { isAuthenticated: boolean; onProjectMutated?: () => void }) {
  const { handle, project: projectName } = useParams<{ handle: string; project: string }>();
  const apiFetch = useApi();
  const [project, setProject] = useState<Project | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !handle || !projectName) return;

    setNotFound(false);
    setProject(null);

    const loadProject = async () => {
      const found = await resolveProject(apiFetch, handle, projectName);
      if (!found) {
        setNotFound(true);
        return;
      }

      const threadRes = await apiFetch(
        `/threads?projectId=${encodeURIComponent(found.id)}&page=1&pageSize=200`,
      );
      if (!threadRes.ok) {
        setNotFound(true);
        return;
      }

      const threadPayload = await threadRes.json() as V1ThreadListResponse;
      const threads = toEnvelopePayload(threadPayload).items.map((item) => normalizeThread(item));
      setProject({
        ...normalizeProject(found),
        threads,
      });
    };

    loadProject().catch(() => setNotFound(true));
  }, [isAuthenticated, handle, projectName, apiFetch]);

  if (notFound) {
    return (
      <main className="main">
        <p className="status-text">Project not found</p>
      </main>
    );
  }

  if (!project) {
    return (
      <main className="main">
        <p className="status-text">Loading…</p>
      </main>
    );
  }

  return (
    <ProjectPage
      project={project}
      onUpdateDescription={async (description) => {
        if (!handle || !projectName) {
          return { error: "Project not found" };
        }
        try {
          const res = await apiFetch(
            `/projects/${encodeURIComponent(handle)}/${encodeURIComponent(projectName)}/description`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ description }),
            },
          );
          if (!res.ok) {
            return { error: await readError(res, "Failed to update project description") };
          }
          const data = await res.json() as { description: string | null };
          setProject((current) => (
            current
              ? {
                  ...current,
                  description: data.description,
                }
              : current
          ));
          onProjectMutated?.();
          return data;
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
          return { error: "Failed to update project description" };
        }
      }}
      onCloseThread={async (threadProjectId) => {
        try {
          const res = await apiFetch(
            appendProjectScope(`/threads/${encodeURIComponent(threadProjectId)}`, project.id),
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "closed" }),
            },
          );
          if (!res.ok) {
            return { error: await readError(res, "Failed to close thread") };
          }
          const data = (await res.json()) as { thread: ThreadDetail };
          setProject((current) => (
            current
              ? {
                  ...current,
                  threads: current.threads.map((thread) =>
                    (
                      thread.id === threadProjectId
                      || (thread.projectThreadId != null && String(thread.projectThreadId) === threadProjectId)
                    )
                      ? { ...thread, status: data.thread.status }
                      : thread,
                  ),
                }
              : current
          ));
          return data;
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
          return { error: "Failed to close thread" };
        }
      }}
      onCommitThread={async (threadProjectId) => {
        try {
          const res = await apiFetch(
            appendProjectScope(`/threads/${encodeURIComponent(threadProjectId)}`, project.id),
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "committed" }),
            },
          );
          if (!res.ok) {
            return { error: await readError(res, "Failed to commit thread") };
          }
          const data = (await res.json()) as { thread: ThreadDetail };
          setProject((current) => (
            current
              ? {
                  ...current,
                  threads: current.threads.map((thread) =>
                    (
                      thread.id === threadProjectId
                      || (thread.projectThreadId != null && String(thread.projectThreadId) === threadProjectId)
                    )
                      ? { ...thread, status: data.thread.status }
                      : thread,
                  ),
                }
              : current
          ));
          return data;
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
          return { error: "Failed to commit thread" };
        }
      }}
      onCloneThread={async (threadProjectId, payload) => {
        const title = typeof payload?.title === "string" ? payload.title.trim() : "";
        const description = typeof payload?.description === "string" ? payload.description.trim() : "";
        try {
          const res = await apiFetch(
            `/threads`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                projectId: project?.id,
                sourceThreadId: threadProjectId,
                title,
                description,
              }),
            },
          );
          if (!res.ok) {
            return { error: await readError(res, "Failed to create thread") };
          }
          const data = (await res.json()) as V1ThreadListItem;
          if (!data?.id) {
            return { error: "New thread not found" };
          }
          setProject((current) => (
            current
              ? {
                  ...current,
                  threads: [...current.threads, normalizeThread({
                    id: data.id,
                    title: data.title,
                    description: data.description,
                    status: data.status,
                    sourceThreadId: data.sourceThreadId,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                    projectId: data.projectId,
                    accessRole: data.accessRole,
                  })],
                }
              : current
          ));
          onProjectMutated?.();
          return {
            thread: {
              id: data.id,
              title: data.title,
              description: data.description,
              status: data.status,
              createdAt: data.createdAt,
              createdByHandle: project?.ownerHandle ?? handle ?? "unknown",
              ownerHandle: project?.ownerHandle ?? handle ?? "unknown",
              projectName: project?.name ?? projectName,
              accessRole: data.accessRole,
            },
          };
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
          return { error: "Failed to create thread" };
        }
      }}
    />
  );
}

function SettingsRoute({
  isAuthenticated,
  onProjectMutated,
}: {
  isAuthenticated: boolean;
  onProjectMutated?: () => void;
}) {
  const { handle, project: projectName } = useParams<{ handle: string; project: string }>();
  const navigate = useNavigate();
  const apiFetch = useApi();
  const [settings, setSettings] = useState<V1ProjectSettingsPayload | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      setSettings(null);
      setNotFound(false);
      return;
    }
    if (!handle || !projectName) {
      setSettings(null);
      setNotFound(true);
      return;
    }

    setSettings(null);
    setNotFound(false);
    let cancelled = false;

    apiFetch(
      `/projects/${encodeURIComponent(handle)}/${encodeURIComponent(projectName)}/collaborators`,
    )
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) {
          throw new Error(await readError(res, "Failed to load project settings"));
        }
        const data = await res.json() as V1ProjectSettingsPayload;
        if (!cancelled) setSettings(data);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });

    return () => {
      cancelled = true;
    };
  }, [apiFetch, handle, isAuthenticated, projectName]);

  if (!isAuthenticated) {
    return (
      <main className="main">
        <p className="status-text">Sign in to access project settings.</p>
      </main>
    );
  }

  if (!notFound && !settings) {
    return (
      <main className="main">
        <p className="status-text">Loading…</p>
      </main>
    );
  }

  if (notFound || !settings || !handle || !projectName) {
    return (
      <main className="main">
        <p className="status-text">Project not found</p>
      </main>
    );
  }

  const encodedHandle = encodeURIComponent(handle);
  const encodedProject = encodeURIComponent(projectName);
  const basePath = `/projects/${encodedHandle}/${encodedProject}`;

  return (
    <ProjectSettingsPage
      projectOwnerHandle={handle}
      projectName={projectName}
      accessRole={settings.accessRole}
      visibility={settings.visibility}
      collaborators={settings.collaborators}
      projectRoles={settings.projectRoles}
      concerns={settings.concerns}
      onSearchUsers={async (query) => {
        if (!query.trim()) return [];
        try {
          const res = await apiFetch(`/users/search?q=${encodeURIComponent(query.trim())}`);
          if (!res.ok) return [];
          return await res.json() as SearchResult[];
        } catch {
          return [];
        }
      }}
      onAddCollaborator={async (targetHandle, role, projectRoles) => {
        try {
          const res = await apiFetch(`${basePath}/collaborators`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ handle: targetHandle, role, projectRoles }),
          });
          if (!res.ok) {
            return { error: await readError(res, "Failed to add collaborator") };
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) return { error: error.message };
          return { error: "Failed to add collaborator" };
        }
      }}
      onRemoveCollaborator={async (targetHandle) => {
        try {
          const res = await apiFetch(`${basePath}/collaborators/${encodeURIComponent(targetHandle)}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            return { error: await readError(res, "Failed to remove collaborator") };
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) return { error: error.message };
          return { error: "Failed to remove collaborator" };
        }
      }}
      onAddRole={async (name) => {
        try {
          const res = await apiFetch(`${basePath}/roles`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) {
            return { error: await readError(res, "Failed to add role") };
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) return { error: error.message };
          return { error: "Failed to add role" };
        }
      }}
      onDeleteRole={async (name) => {
        try {
          const res = await apiFetch(`${basePath}/roles/${encodeURIComponent(name)}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            return { error: await readError(res, "Failed to delete role") };
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) return { error: error.message };
          return { error: "Failed to delete role" };
        }
      }}
      onAddConcern={async (name) => {
        try {
          const res = await apiFetch(`${basePath}/concerns`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) {
            return { error: await readError(res, "Failed to add concern") };
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) return { error: error.message };
          return { error: "Failed to add concern" };
        }
      }}
      onDeleteConcern={async (name) => {
        try {
          const res = await apiFetch(`${basePath}/concerns/${encodeURIComponent(name)}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            return { error: await readError(res, "Failed to delete concern") };
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) return { error: error.message };
          return { error: "Failed to delete concern" };
        }
      }}
      onUpdateMemberRoles={async (targetHandle, projectRoles) => {
        try {
          const res = await apiFetch(`${basePath}/collaborators/${encodeURIComponent(targetHandle)}/roles`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectRoles }),
          });
          if (!res.ok) {
            return { error: await readError(res, "Failed to update member roles") };
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) return { error: error.message };
          return { error: "Failed to update member roles" };
        }
      }}
      onUpdateVisibility={async (visibility) => {
        try {
          const res = await apiFetch(`${basePath}/visibility`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ visibility }),
          });
          if (!res.ok) {
            return { error: await readError(res, "Failed to update visibility") };
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) return { error: error.message };
          return { error: "Failed to update visibility" };
        }
      }}
      onArchiveProject={async () => {
        try {
          const res = await apiFetch(`${basePath}/archive`, { method: "POST" });
          if (!res.ok) {
            return { error: await readError(res, "Failed to archive project") };
          }
          onProjectMutated?.();
          navigate("/");
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) return { error: error.message };
          return { error: "Failed to archive project" };
        }
      }}
    />
  );
}

function ThreadRoute({ isAuthenticated, onProjectMutated }: { isAuthenticated: boolean; onProjectMutated?: () => void }) {
  const { handle, project: projectName, threadId } = useParams<{
    handle: string;
    project: string;
    threadId: string;
  }>();
  const apiFetch = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const [detail, setDetail] = useState<ThreadDetailPayload | null>(null);
  const [threadProjectId, setThreadProjectId] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const eventCursorRef = useRef<string | null>(null);
  const eventStreamAbortRef = useRef<AbortController | null>(null);
  const eventPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const [integrationStatuses, setIntegrationStatuses] = useState<IntegrationStatusRecord>({
    notion: "disconnected",
    google: "disconnected",
  });

  useEffect(() => {
    if (!isAuthenticated || !handle || !projectName) {
      setThreadProjectId(null);
      return;
    }
    setThreadProjectId(null);
    let cancelled = false;
    resolveProject(apiFetch, handle, projectName)
      .then((projectRecord) => {
        if (!cancelled) setThreadProjectId(projectRecord?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setThreadProjectId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, handle, isAuthenticated, projectName]);

  const threadPathWithScope = useCallback((suffix = ""): string | null => {
    if (!threadId) return null;
    const path = `/threads/${encodeURIComponent(threadId)}${suffix}`;
    return appendProjectScope(path, threadProjectId);
  }, [threadId, threadProjectId]);

  const resolveThreadProjectId = useCallback(async (): Promise<string | null> => {
    if (threadProjectId) return threadProjectId;
    if (!handle || !projectName) return null;
    const projectRecord = await resolveProject(apiFetch, handle, projectName);
    const resolved = projectRecord?.id ?? null;
    if (resolved) setThreadProjectId(resolved);
    return resolved;
  }, [apiFetch, handle, projectName, threadProjectId]);

  const refreshThread = useCallback(async () => {
    if (!threadId) return;
    if (isNumericThreadRouteId(threadId) && !threadProjectId) return;
    const scopedPath = threadPathWithScope();
    if (!scopedPath) return;
    const threadRes = await apiFetch(scopedPath);
    if (!threadRes.ok) return;
    const nextDetail = (await threadRes.json()) as ThreadDetailPayload;
    setDetail(nextDetail);
  }, [apiFetch, threadId, threadPathWithScope, threadProjectId]);

  const refreshThreadDebounced = useCallback(() => {
    if (eventRefreshPromiseRef.current) return;
    const refresh = (async () => {
      try {
        await refreshThread();
      } catch (error) {
        console.error("Thread refresh failed:", error);
      } finally {
        if (eventRefreshPromiseRef.current === refresh) {
          eventRefreshPromiseRef.current = null;
        }
      }
    })();
    eventRefreshPromiseRef.current = refresh;
  }, [refreshThread]);

  const handleThreadEvent = useCallback(
    async (event: V1EventItem) => {
      if (!threadId) return;
      const detailThreadId = detail?.thread.id;
      if (!isThreadEvent(event, threadId) && !(detailThreadId && isThreadEvent(event, detailThreadId))) return;
      if (
        event.type === "assistant.run.started"
        || event.type === "assistant.run.progress"
        || event.type === "assistant.run.waiting_input"
        || event.type === "assistant.run.completed"
        || event.type === "assistant.run.failed"
        || event.type === "assistant.run.cancelled"
        || event.type === "thread.matrix.changed"
        || event.type === "chat.session.finished"
      ) {
        refreshThreadDebounced();
      }
    },
    [detail?.thread.id, refreshThreadDebounced, threadId],
  );

  const processEventPayload = useCallback(async (event: V1EventItem) => {
    try {
      await handleThreadEvent(event);
    } catch (error) {
      console.error("Failed to process v1 event:", error);
    }
  }, [handleThreadEvent]);

  useEffect(() => {
    if (!isAuthenticated || !threadId) return;

    let mounted = true;
    let pollingOnly = false;
    eventCursorRef.current = null;

    const stopStream = () => {
      if (eventStreamAbortRef.current) {
        eventStreamAbortRef.current.abort();
        eventStreamAbortRef.current = null;
      }
    };

    const stopPolling = () => {
      if (eventPollTimerRef.current) {
        clearTimeout(eventPollTimerRef.current);
        eventPollTimerRef.current = null;
      }
    };

    const startPolling = () => {
      if (!mounted || pollingOnly) return;
      pollingOnly = true;

      const poll = async () => {
        if (!mounted || !pollingOnly) return;
        const since = eventCursorRef.current;
        const cursorQuery = since ? `?since=${encodeURIComponent(since)}&limit=100` : "?limit=100";
        try {
          const eventsResponse = await apiFetch(`/events${cursorQuery}`);
          if (eventsResponse.ok) {
            const payload = await eventsResponse.json() as {
              items?: V1EventItem[];
              nextCursor?: string | null;
            };
            const items = payload.items ?? [];
            for (const event of items) {
              await processEventPayload(event);
            }
            if (items.length > 0) {
              eventCursorRef.current = payload.nextCursor ?? eventCursorFromItem(items[items.length - 1] as V1EventItem);
            }
          } else {
            throw new Error("events poll failed");
          }
        } catch (error) {
          console.error("Event polling failed:", error);
        }

        if (!mounted) return;
        eventPollTimerRef.current = setTimeout(poll, 5000);
      };

      poll();
    };

    const startSse = async () => {
      pollingOnly = false;
      stopPolling();

      const start = async () => {
        while (mounted && !pollingOnly) {
          const cursorQuery = eventCursorRef.current
            ? `?since=${encodeURIComponent(eventCursorRef.current)}&limit=100`
            : "?limit=100";
          const headers = eventCursorRef.current
            ? { "Last-Event-ID": eventCursorRef.current }
            : undefined;

          const controller = new AbortController();
          eventStreamAbortRef.current = controller;
          try {
            const response = await apiFetch(`/events/stream${cursorQuery}`, {
              headers,
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new Error("events stream not available");
            }

            const reader = response.body?.getReader();
            if (!reader) {
              throw new Error("events stream has no body");
            }

            const decoder = new TextDecoder();
            let buffer = "";

            while (mounted && !pollingOnly && !controller.signal.aborted) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (!chunk.value) continue;

              const chunkText = decoder.decode(chunk.value, { stream: true });
              buffer += chunkText;
              const parsed = parseSSEPackets(buffer);
              buffer = parsed.remainder;

              for (const packet of parsed.packets) {
                if (!packet.data || packet.type === "message") continue;
                try {
                  const eventData = JSON.parse(packet.data) as V1EventItem;
                  eventData.id = packet.id || eventCursorFromItem(eventData);
                  eventCursorRef.current = eventData.id;
                  await processEventPayload(eventData);
                } catch (parseError) {
                  console.error("Failed to parse SSE packet:", parseError);
                }
              }
            }
          } catch (error) {
            if (!mounted || pollingOnly) {
              return;
            }
            const shouldFallback = !(
              error instanceof DOMException && error.name === "AbortError"
            );
            if (shouldFallback) {
              startPolling();
              return;
            }
          } finally {
            if (eventStreamAbortRef.current === controller) {
              eventStreamAbortRef.current = null;
            }
          }
          if (mounted && !pollingOnly) {
            await new Promise((resolve) => {
              setTimeout(resolve, 3000);
            });
          }
        }
      };

      await start();
    };

    void startSse();

    return () => {
      mounted = false;
      stopStream();
      stopPolling();
      pollingOnly = true;
    };
  }, [apiFetch, handleThreadEvent, isAuthenticated, processEventPayload, threadId]);

  const refreshIntegrationStatuses = useCallback(async () => {
    const nextStatuses: IntegrationStatusRecord = {
      notion: "disconnected",
      google: "disconnected",
    };
    await Promise.all(
      (["notion", "google"] as IntegrationProvider[]).map(async (provider) => {
        try {
          const res = await apiFetch(`/integrations/${provider}/status`);
          if (!res.ok) return;
          const data = (await res.json()) as { status: IntegrationStatusRecord[IntegrationProvider] };
          nextStatuses[provider] = data.status;
        } catch {
          // Keep fallback disconnected.
        }
      }),
    );
    setIntegrationStatuses(nextStatuses);
  }, [apiFetch]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refreshIntegrationStatuses();
  }, [isAuthenticated, refreshIntegrationStatuses]);

  useEffect(() => {
    const provider = searchParams.get("integration");
    const status = searchParams.get("integration_status");
    if (!provider || !status) return;
    if (isAuthenticated) {
      void refreshIntegrationStatuses();
    }
    setSearchParams((params) => {
      params.delete("integration");
      params.delete("integration_status");
      return params;
    }, { replace: true });
  }, [isAuthenticated, refreshIntegrationStatuses, searchParams, setSearchParams]);

  useEffect(() => {
    if (!isAuthenticated || !threadId) return;
    if (isNumericThreadRouteId(threadId) && !threadProjectId) return;

    setNotFound(false);
    setDetail(null);

    const scopedPath = threadPathWithScope();
    if (!scopedPath) {
      setNotFound(true);
      return;
    }

    apiFetch(scopedPath)
      .then(async (res) => {
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) {
          throw new Error(await readError(res, "Failed to load thread"));
        }
        setDetail(await res.json());
      })
      .catch(() => setNotFound(true));
  }, [isAuthenticated, threadId, apiFetch, threadPathWithScope, threadProjectId]);

  if (notFound) {
    return (
      <main className="main">
        <p className="status-text">Thread not found</p>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="main">
        <p className="status-text">Loading…</p>
      </main>
    );
  }

    return (
    <ThreadPage
      detail={detail}
      threadRouteId={threadId}
      integrationStatuses={integrationStatuses}
      disableChatInputs={false}
      onUpdateThread={async (payload) => {
        try {
          const scopedPath = threadPathWithScope();
          if (!scopedPath) {
            return { error: "Unable to determine thread context." };
          }
          const res = await apiFetch(
            scopedPath,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
          if (!res.ok) {
            return { error: await readError(res, "Failed to update thread") };
          }
          const data = (await res.json()) as { thread: ThreadDetail };
          setDetail((prev) => (prev ? { ...prev, thread: data.thread } : prev));
          onProjectMutated?.();
          return data;
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
          return { error: "Failed to update thread" };
        }
      }}
      onSaveTopologyLayout={async (payload) => {
        const scopedPath = threadPathWithScope("/matrix");
        if (!scopedPath) {
          return { error: "Unable to determine thread context." };
        }
        const res = await apiFetch(
          scopedPath,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ layout: payload.positions }),
          },
        );
        if (!res.ok) {
          return { error: await readError(res, "Failed to save topology layout") };
        }
        const data = (await res.json()) as { systemId: string };
        setDetail((prev) => (
          prev
            ? {
                ...applyTopologyPositions(prev, payload.positions),
                systemId: data.systemId,
              }
            : prev
        ));
        return data;
      }}
      onAddMatrixDoc={async (payload: MatrixRefInput) => {
        const scopedPath = threadPathWithScope("/matrix/refs");
        if (!scopedPath) {
          return { error: "Unable to determine thread context." };
        }
        const res = await apiFetch(
          scopedPath,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          return { error: await readError(res, "Failed to attach document") };
        }
        const data = (await res.json()) as MatrixRefMutationResponse;
        setDetail((prev) => (prev ? applyMatrixMutationResponse(prev, data) : prev));
        return data;
      }}
      onRemoveMatrixDoc={async (payload: MatrixRefInput) => {
        const scopedPath = threadPathWithScope("/matrix/refs");
        if (!scopedPath) {
          return { error: "Unable to determine thread context." };
        }
        const res = await apiFetch(
          scopedPath,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          return { error: await readError(res, "Failed to remove document") };
        }
        const data = (await res.json()) as MatrixRefMutationResponse;
        setDetail((prev) => (prev ? applyMatrixMutationResponse(prev, data) : prev));
        return data;
      }}
      onCreateMatrixDocument={async (payload: MatrixDocumentCreateInput) => {
        const scopedPath = threadPathWithScope("/matrix/documents");
        if (!scopedPath) {
          return { error: "Unable to determine thread context." };
        }
        const res = await apiFetch(
          scopedPath,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          return { error: await readError(res, "Failed to create document") };
        }
        const data = (await res.json()) as MatrixDocumentCreateResponse;
        setDetail((prev) => {
          if (!prev) return prev;

          const responseCells = normalizeMutationCells(data);
          const attach = payload.attach;
          const attachConcerns = getAttachConcerns(attach);
          const fallbackAttach: { nodeId: string; refType: "Document" | "Skill" } | null =
            attach && (attach.refType === "Document" || attach.refType === "Skill")
              ? { nodeId: attach.nodeId, refType: attach.refType }
            : null;
          const fallbackCells = payload.kind !== "Prompt" && fallbackAttach && responseCells.length === 0
            ? buildFallbackAttachedCells(
                prev.matrix.cells,
                fallbackAttach.nodeId,
                attachConcerns,
                fallbackAttach.refType,
                data.document,
              )
            : [];
          const nextCells = responseCells.length > 0 ? responseCells : fallbackCells;

          return {
            ...prev,
            systemId: data.systemId,
            matrix: payload.kind === "Prompt"
              ? prev.matrix
              : {
                  ...prev.matrix,
                  documents: upsertMatrixDocument(prev.matrix.documents, data.document),
                  cells: nextCells.length === 0
                    ? prev.matrix.cells
                    : applyMutationCells(prev.matrix.cells, nextCells),
                },
            chat: {
              ...prev.chat,
              messages: mergeChatMessages(prev.chat.messages, data.messages ?? []),
            },
            ...(data.systemPrompt === undefined
              ? {}
              : {
                  systemPrompt: data.systemPrompt ?? null,
                  systemPromptTitle: data.systemPromptTitle ?? null,
                  systemPrompts: data.systemPrompts ?? [],
                }),
          };
        });
        return data;
      }}
      onReplaceMatrixDocument={async (documentHash: string, payload: MatrixDocumentReplaceInput) => {
        const scopedPath = threadPathWithScope(`/matrix/documents/${encodeURIComponent(documentHash)}`);
        if (!scopedPath) {
          return { error: "Unable to determine thread context." };
        }
        const res = await apiFetch(
          scopedPath,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          return { error: await readError(res, "Failed to update document") };
        }
        const data = (await res.json()) as MatrixDocumentReplaceResponse;
        setDetail((prev) => {
          if (!prev) return prev;

          const isPromptDocument = data.systemPrompt !== undefined;
          return {
            ...prev,
            systemId: data.systemId,
            matrix: isPromptDocument
              ? prev.matrix
              : {
                  ...prev.matrix,
                  documents: replaceMatrixDocumentInGlobalList(prev.matrix.documents, data.oldHash, data.document),
                  cells: replaceMatrixDocumentReferences(prev.matrix.cells, data.oldHash, data.document),
                },
            chat: {
              ...prev.chat,
              messages: mergeChatMessages(prev.chat.messages, data.messages ?? []),
            },
            ...(data.systemPrompt === undefined
              ? {}
              : {
                  systemPrompt: data.systemPrompt ?? null,
                  systemPromptTitle: data.systemPromptTitle ?? null,
                  systemPrompts: data.systemPrompts ?? [],
                }),
          };
        });
        return data;
      }}
      onSendChatMessage={async (payload) => {
        const scopedPath = threadPathWithScope("/chat");
        if (!scopedPath) {
          return { error: "Unable to determine thread context." };
        }
        const res = await apiFetch(
          scopedPath,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          return { error: await readError(res, "Failed to send chat message") };
        }
        const data = (await res.json()) as { messages: ChatMessage[] };
        setDetail((prev) => (
          prev
            ? {
                ...prev,
                chat: {
                  ...prev.chat,
                  messages: mergeChatMessages(prev.chat.messages, data.messages),
                },
              }
            : prev
        ));

        return data;
      }}
      onRunAssistant={async (payload) => {
        const assistantType = payload.mode === "plan" ? "plan" : "direct";
        const requestPayload = {
          ...payload,
          executor: payload.mode === "direct" ? "desktop" : payload.executor ?? "backend",
          wait: payload.mode === "direct" ? false : payload.wait ?? true,
        };
        const resolveRunResult = async (runId: string) => {
          const runRes = await apiFetch(
            `/assistant-runs/${encodeURIComponent(runId)}`,
          );
          if (!runRes.ok) {
            return null;
          }
          return (await runRes.json()) as AssistantRunResultResponse;
        };

        const scopedRunPath = threadPathWithScope(`/assistants/${assistantType}/runs`);
        if (!scopedRunPath) {
          return { error: "Unable to determine thread context." };
        }
        const res = await apiFetch(
          scopedRunPath,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestPayload),
          },
        );
        if (!res.ok) {
          return { error: await readError(res, "Failed to run assistant") };
        }
        const data = (await res.json()) as unknown;
        const runStartResponse = data as {
          runId?: string;
          status?: "queued" | "running" | "success" | "failed";
          systemId?: string;
          messages?: Array<{
            id: string;
            actionId: string;
            role: "User" | "Assistant" | "System";
            actionType: string;
            actionPosition: number;
            content: string;
            createdAt: string;
          }>;
        };
        const refreshThread = async () => {
          const scopedPath = threadPathWithScope();
          if (!scopedPath) return null;
          const threadRes = await apiFetch(
            scopedPath,
          );
          if (!threadRes.ok) {
            return null;
          }
          return (await threadRes.json()) as ThreadDetailPayload;
        };
        if (
          requestPayload.executor === "desktop"
          && payload.mode === "direct"
          && (runStartResponse.status === "queued" || runStartResponse.status === "running")
          && typeof runStartResponse.runId === "string"
        ) {
          const targetProjectId = await resolveThreadProjectId();
          const localRun = await window.electronAPI.assistant?.run?.({
            handle: handle ?? "",
            projectName: projectName ?? "",
            threadId: threadId ?? "",
            projectId: targetProjectId ?? undefined,
            runId: runStartResponse.runId,
          });
          if (localRun) {
            if ("error" in localRun && typeof localRun.error === "string") {
              return localRun;
            }
            let localResult = localRun as AssistantRunResponse;
            let localThreadState = localResult.threadState;
            let messageRefreshThread: ThreadDetailPayload | null = null;
            if (!localResult.messages || localResult.messages.length === 0) {
              const refreshed = await resolveRunResult(runStartResponse.runId);
              if (refreshed && !("error" in refreshed) && refreshed.messages && refreshed.messages.length > 0) {
                localThreadState = refreshed.threadState ?? localThreadState;
                localResult = {
                  ...localResult,
                  ...refreshed,
                  filesChanged: refreshed.filesChanged ?? localResult.filesChanged,
                  changesCount: refreshed.changesCount ?? localResult.changesCount,
                  planActionId: refreshed.planActionId ?? localResult.planActionId,
                  planResponseActionId: refreshed.planResponseActionId ?? localResult.planResponseActionId,
                  executeActionId: refreshed.executeActionId ?? localResult.executeActionId,
                  executeResponseActionId: refreshed.executeResponseActionId ?? localResult.executeResponseActionId,
                  updateActionId: refreshed.updateActionId ?? localResult.updateActionId,
                  messages: refreshed.messages,
                } as AssistantRunResponse;
              } else {
                const refreshedThread = await refreshThread();
                if (refreshedThread) {
                  messageRefreshThread = refreshedThread;
                  const assistantMessages = [...refreshedThread.chat.messages]
                    .filter((message) => message.role === "Assistant")
                    .sort((a, b) => {
                      const aPosition = typeof a.actionPosition === "number" ? a.actionPosition : Number.MAX_SAFE_INTEGER;
                      const bPosition = typeof b.actionPosition === "number" ? b.actionPosition : Number.MAX_SAFE_INTEGER;
                      return aPosition - bPosition;
                    })
                    .slice(-1);
                  localResult = {
                    ...localResult,
                    messages: assistantMessages,
                  } as AssistantRunResponse;
                }
              }
            }

            if (
              requestPayload.executor === "desktop"
              && requestPayload.mode === "direct"
              && !localThreadState
              && typeof localResult.changesCount === "number"
              && localResult.changesCount > 0
            ) {
              localThreadState = messageRefreshThread;
              if (!localThreadState) {
                const refreshedThread = await refreshThread();
                if (refreshedThread) {
                  localThreadState = refreshedThread;
                }
              }
            }

            setDetail((prev) => (
              prev
                ? {
                    ...mergeThreadStateFromRun(prev, localThreadState),
                    systemId: localResult.systemId,
                    chat: {
                      ...prev.chat,
                      messages: mergeChatMessages(prev.chat.messages, localResult.messages ?? []),
                    },
                  }
                : prev
            ));
            return localResult;
          }
        }
        const finalResult = data as AssistantRunResponse;
        let finalThreadState = finalResult.threadState;
        if (
          requestPayload.mode === "direct"
          && !finalThreadState
          && typeof finalResult.changesCount === "number"
          && finalResult.changesCount > 0
        ) {
          const scopedPath = threadPathWithScope();
          if (!scopedPath) {
            return { error: "Unable to determine thread context." };
          }
          const threadRes = await apiFetch(scopedPath);
          if (threadRes.ok) {
            finalThreadState = await threadRes.json() as ThreadDetailPayload;
          }
        }
        setDetail((prev) => (
          prev
            ? {
                ...mergeThreadStateFromRun(prev, finalThreadState),
                systemId: finalResult.systemId,
                chat: {
                  ...prev.chat,
                  messages: mergeChatMessages(prev.chat.messages, finalResult.messages),
                },
              }
            : prev
        ));

        return finalResult;
      }}
      onCloseThread={async () => {
        try {
          const scopedPath = threadPathWithScope();
          if (!scopedPath) {
            return { error: "Unable to determine thread context." };
          }
          const res = await apiFetch(
            scopedPath,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "closed" }),
            },
          );
          if (!res.ok) {
            return { error: await readError(res, "Failed to close thread") };
          }
          const data = (await res.json()) as { thread: ThreadDetail };
          setDetail((prev) => (prev ? { ...prev, thread: data.thread } : prev));
          return data;
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
          return { error: "Failed to close thread" };
        }
      }}
      onCommitThread={async () => {
        try {
          const scopedPath = threadPathWithScope();
          if (!scopedPath) {
            return { error: "Unable to determine thread context." };
          }
          const res = await apiFetch(
            scopedPath,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "committed" }),
            },
          );
          if (!res.ok) {
            return { error: await readError(res, "Failed to commit thread") };
          }
          const data = (await res.json()) as { thread: ThreadDetail };
          setDetail((prev) => (prev ? { ...prev, thread: data.thread } : prev));
          return data;
        } catch (error: unknown) {
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
          return { error: "Failed to commit thread" };
        }
      }}
    />
  );
}

function AppShell({
  projects,
  setProjects,
  isAuthenticated,
  refreshProjects,
}: {
  projects: Project[];
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  isAuthenticated: boolean;
  refreshProjects: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem("acx-sidebar") !== "false";
    } catch {
      return true;
    }
  });

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem("acx-sidebar", String(next)); } catch {}
      return next;
    });
  }, []);

  const segments = location.pathname.replace(/^\//, "").split("/").filter(Boolean);
  const isProjectRoute = segments.length >= 2 && segments[0] !== "settings";
  const handle = isProjectRoute ? segments[0] : undefined;
  const projectName = isProjectRoute ? segments[1] : undefined;

  useEffect(() => {
    if (!isAuthenticated && location.pathname !== "/") {
      navigate("/", { replace: true });
    }
  }, [isAuthenticated, location.pathname, navigate]);

  return (
    <>
      <NavigateSync />
      <Header
        variant="desktop"
        projectLabel={handle && projectName ? `${handle} / ${projectName}` : undefined}
        projectHref={handle && projectName ? `/${handle}/${projectName}` : undefined}
        onToggleSidebar={toggleSidebar}
      />
      <div className="app-layout">
        {isAuthenticated && (
          <Sidebar
            projects={projects}
            activeProjectOwner={handle}
            activeProjectName={projectName}
            open={sidebarOpen}
          />
        )}
        <div className="app-content">
          <Routes>
            <Route path="/" element={<HomeRoute projects={projects} setProjects={setProjects} />} />
            <Route path="/:handle/:project" element={<ProjectRoute isAuthenticated={isAuthenticated} onProjectMutated={refreshProjects} />} />
            <Route path="/settings" element={<AccountSettingsRoute isAuthenticated={isAuthenticated} />} />
            <Route
              path="/:handle/:project/settings"
              element={<SettingsRoute isAuthenticated={isAuthenticated} onProjectMutated={refreshProjects} />}
            />
            <Route path="/:handle" element={<ProfileRoute isAuthenticated={isAuthenticated} />} />
            <Route
              path="/:handle/:project/thread/:threadId"
              element={<ThreadRoute isAuthenticated={isAuthenticated} onProjectMutated={refreshProjects} />}
            />
          </Routes>
        </div>
      </div>
    </>
  );
}

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsKey, setProjectsKey] = useState(0);

  const refreshProjects = useCallback(() => setProjectsKey((k) => k + 1), []);

  useEffect(() => {
    const { auth } = window.electronAPI;

    auth.getState().then((state) => {
      setIsAuthenticated(state.isAuthenticated);
      setIsLoading(false);
    });

    const unsubscribe = auth.onStateChanged((state) => {
      setIsAuthenticated(state.isAuthenticated);
      setIsLoading(false);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setUser(null);
      setProjects([]);
      return;
    }

    Promise.all([desktopApiFetch("/me"), desktopApiFetch("/projects")])
      .then(async ([meRes, projRes]) => {
        if (meRes.ok) {
          const me = await meRes.json();
          setUser({ handle: me.handle, email: me.email ?? null, githubHandle: me.githubHandle ?? "", name: me.name, picture: me.picture });
        }

        if (projRes.ok) {
          const projectsData = (await projRes.json()) as V1ProjectListResponse;
          setProjects(toEnvelopePayload(projectsData).items.map((project) => normalizeProject(project)));
        }
      })
      .catch((err) => {
        console.error("API fetch failed:", err);
      });
  }, [isAuthenticated, projectsKey]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        user,
        login: () => window.electronAPI.auth.login(),
        logout: () => window.electronAPI.auth.logout(),
      }}
    >
      <AppShell projects={projects} setProjects={setProjects} isAuthenticated={isAuthenticated} refreshProjects={refreshProjects} />
    </AuthContext.Provider>
  );
}
