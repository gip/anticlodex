import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
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

function normalizeProject(item: V1ProjectListItem, threads: Array<{
  id: string;
  title: string | null;
  description: string | null;
  projectThreadId?: number | null;
  status: "open" | "closed" | "committed";
  sourceThreadId?: string | null;
  updatedAt: string;
}> = []): Project {
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
    })) ?? threads,
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
} {
  return {
    id: row.id,
    projectThreadId: row.projectThreadId,
    title: row.title,
    description: row.description,
    status: row.status,
    sourceThreadId: row.sourceThreadId,
    updatedAt: row.updatedAt,
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
  project: V1ProjectListItem | { id: string; name: string; ownerHandle: string; accessRole: string; threadCount?: number },
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
  const projectsRes = await apiFetch("/projects", undefined, { auth: "optional" });
  if (!projectsRes.ok) return null;
  const projectsData = await projectsRes.json() as V1ProjectListResponse;
  return projectsData.items.find((project) => project.ownerHandle === handle && project.name === projectName) ?? null;
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

type MatrixRefMutationResponse = {
  systemId: string;
  cell?: MatrixCell;
  cells?: MatrixCell[];
  systemPrompt?: string | null;
  systemPromptTitle?: string | null;
  systemPrompts?: Array<{
    hash: string;
    title: string;
    text: string;
  }>;
  messages?: ChatMessage[];
};

interface MatrixDocumentCreateResponse {
  systemId: string;
  document: MatrixDocument;
  cell?: MatrixCell;
  cells?: MatrixCell[];
  systemPrompt?: string | null;
  systemPromptTitle?: string | null;
  systemPrompts?: Array<{
    hash: string;
    title: string;
    text: string;
  }>;
  messages?: ChatMessage[];
}

interface MatrixDocumentReplaceResponse {
  systemId: string;
  oldHash: string;
  document: MatrixDocument;
  replacedRefs: number;
  systemPrompt?: string | null;
  systemPromptTitle?: string | null;
  systemPrompts?: Array<{
    hash: string;
    title: string;
    text: string;
  }>;
  messages?: ChatMessage[];
}

function normalizeMutationCells(response: MatrixRefMutationResponse): MatrixCell[] {
  const cells = response.cells?.length ? response.cells : response.cell ? [response.cell] : [];
  return cells.filter((cell): cell is MatrixCell => Boolean(cell.nodeId && cell.concern));
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

function applyMutationCells(
  currentCells: MatrixCell[],
  nextCells: MatrixCell[],
): MatrixCell[] {
  return nextCells.reduce((cells, nextCell) => upsertMatrixCell(cells, nextCell), currentCells);
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

function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const existing = new Set(current.map((message) => message.id));
  const next = incoming.filter((message) => !existing.has(message.id));
  return [...current, ...next];
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

function useApi() {
  const { getAccessTokenSilently, isAuthenticated, isLoading } = useAuth0();

  const isRecoverableAuthError = useCallback((error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const code = "error" in error && typeof (error as { error?: unknown }).error === "string"
      ? (error as { error: string }).error
      : null;
    return code === "login_required" || code === "consent_required" || code === "missing_refresh_token";
  }, []);

  const apiFetch = useCallback(
    async (
      path: string,
      init?: RequestInit,
      options?: { auth?: "required" | "optional" | "none" },
    ) => {
      const authMode = options?.auth ?? "required";
      let token: string | null = null;
      const shouldTryToken =
        authMode !== "none" && (authMode === "required" || (isAuthenticated && !isLoading));
      if (shouldTryToken) {
        try {
          token = await getAccessTokenSilently();
        } catch (error) {
          if (authMode === "required" || !isRecoverableAuthError(error)) {
            throw error;
          }
        }
      }

      const headers = new Headers(init?.headers ?? {});
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }

      return fetch(`${API_URL}${path}`, {
        ...init,
        headers,
      });
    },
    [getAccessTokenSilently, isAuthenticated, isLoading, isRecoverableAuthError],
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

function NotFoundRoute() {
  return (
    <main className="main">
      <div className="page">
        <h1>404</h1>
        <p className="status-text">Page not found.</p>
        <p className="page-description">
          <Link to="/">Back to home</Link>
        </p>
      </div>
    </main>
  );
}

function HomePage({
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
        const res = await apiFetch(`/projects/check-name?name=${encodeURIComponent(name)}`);
        if (!res.ok) return true;
        const data = await res.json();
        return data.available;
      }}
  onCreateProject={async (data) => {
        const res = await apiFetch("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { error: body.error ?? "Failed to create project" };
        }
        const project = await res.json() as V1ProjectListItem;
        setProjects((prev) => [normalizeProject(project), ...prev]);
      }}
    />
  );
}

function ProfileRoute() {
  const { handle } = useParams<{ handle: string }>();
  const apiFetch = useApi();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!handle) return;

    setNotFound(false);
    setProfile(null);

    apiFetch(`/users/${encodeURIComponent(handle)}`, undefined, { auth: "optional" })
      .then(async (res) => {
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        setProfile(await res.json());
      })
      .catch(() => setNotFound(true));
  }, [handle, apiFetch]);

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

function AccountSettingsRoute() {
  const { isAuthenticated, isLoading } = useAuth();
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
          const data = (await res.json().catch(() => ({ status: "disconnected" as IntegrationConnectionStatus }))) as {
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

function ProjectRoute({ onProjectMutated }: { onProjectMutated?: () => void }) {
  const { handle, project: projectName } = useParams<{ handle: string; project: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const apiFetch = useApi();
  const fromParam = searchParams.get("from");
  const fromThreadId = fromParam?.trim() || null;
  const [project, setProject] = useState<Project | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!handle || !projectName) return;

    const loadProject = async () => {
      const found = await resolveProject(apiFetch, handle, projectName);
      if (!found) {
        setNotFound(true);
        return;
      }

      const threadRes = await apiFetch(
        `/threads?projectId=${encodeURIComponent(found.id)}&page=1&pageSize=200`,
        undefined,
        { auth: "optional" },
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

    loadProject().catch(() => {
      setNotFound(true);
    });
  }, [handle, projectName, apiFetch]);

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
      fromThreadId={fromThreadId}
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
                projectId: project.id,
                sourceThreadId: threadProjectId,
                title,
                description,
              }),
            },
          );
          if (!res.ok) {
            return { error: await readError(res, "Failed to create thread") };
          }
          const data = await res.json() as V1ThreadListItem & { createdAt?: string };
          if (!data?.id) {
            return { error: "New thread not found" };
          }
          const created = toThreadDetailFromSummary(data, project);
          setProject((current) => (
            current
              ? {
                  ...current,
                  threads: [ ...current.threads, normalizeThread({ ...data, sourceThreadId: data.sourceThreadId ?? null })],
                }
              : current
          ));
          onProjectMutated?.();
          const threadRouteId = data.projectThreadId != null ? String(data.projectThreadId) : data.id;
          navigate(`/${encodeURIComponent(handle!)}/${encodeURIComponent(projectName!)}/thread/${threadRouteId}`);
          return { thread: created };
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

function SettingsRoute({ onProjectMutated }: { onProjectMutated?: () => void }) {
  const { handle, project: projectName } = useParams<{ handle: string; project: string }>();
  const { isAuthenticated, isLoading } = useAuth();
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
        if (!cancelled) {
          setSettings(data);
        }
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

  if (isLoading || (!notFound && !settings)) {
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
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
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
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
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
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
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
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
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
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
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
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
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
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
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
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
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
          if (error instanceof Error && error.message.trim()) {
            return { error: error.message };
          }
          return { error: "Failed to archive project" };
        }
      }}
    />
  );
}

function ThreadRoute({ onProjectMutated }: { onProjectMutated?: () => void }) {
  const { handle, project: projectName, threadId } = useParams<{
    handle: string;
    project: string;
    threadId: string;
  }>();
  const { isAuthenticated } = useAuth0();
  const navigate = useNavigate();
  const apiFetch = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const [detail, setDetail] = useState<ThreadDetailPayload | null>(null);
  const [threadProjectId, setThreadProjectId] = useState<string | null>(null);
  const [isProjectResolved, setIsProjectResolved] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const eventCursorRef = useRef<string | null>(null);
  const eventStreamAbortRef = useRef<AbortController | null>(null);
  const eventPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventRefreshPromiseRef = useRef<Promise<void> | null>(null);
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
    if (!handle || !projectName) {
      setThreadProjectId(null);
      setIsProjectResolved(false);
      return;
    }
    setThreadProjectId(null);
    setIsProjectResolved(false);
    let cancelled = false;
    resolveProject(apiFetch, handle, projectName)
      .then((projectRecord) => {
        if (!cancelled) {
          setThreadProjectId(projectRecord?.id ?? null);
          setIsProjectResolved(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThreadProjectId(null);
          setIsProjectResolved(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, handle, projectName]);

  const threadPathWithScope = useCallback((suffix = ""): string | null => {
    if (!threadId) return null;
    const path = `/threads/${encodeURIComponent(threadId)}${suffix}`;
    return appendProjectScope(path, threadProjectId);
  }, [threadId, threadProjectId]);

  const refreshThread = useCallback(async () => {
    if (!threadId) return;
    if (isNumericThreadRouteId(threadId) && (!isProjectResolved || !threadProjectId)) return;
    const scopedPath = threadPathWithScope();
    if (!scopedPath) return;
    const threadRes = await apiFetch(scopedPath, undefined, { auth: "optional" });
    if (!threadRes.ok) return;
    const nextDetail = await threadRes.json() as ThreadDetailPayload;
    setDetail(nextDetail);
  }, [apiFetch, isProjectResolved, threadId, threadPathWithScope, threadProjectId]);

  const refreshThreadDebounced = useCallback(() => {
    if (eventRefreshPromiseRef.current) return;
    eventRefreshPromiseRef.current = (async () => {
      try {
        await refreshThread();
      } catch (error) {
        console.error("Thread refresh failed:", error);
      } finally {
        if (eventRefreshPromiseRef.current) {
          eventRefreshPromiseRef.current = null;
        }
      }
    })();
  }, [refreshThread]);

  const resolveThreadProjectId = useCallback(async (): Promise<string | null> => {
    if (threadProjectId) return threadProjectId;
    if (!handle || !projectName) return null;
    const projectRecord = await resolveProject(apiFetch, handle, projectName);
    const resolved = projectRecord?.id ?? null;
    if (resolved) setThreadProjectId(resolved);
    return resolved;
  }, [apiFetch, handle, projectName, threadProjectId]);

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
            // Retry stream after a brief delay.
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
    if (!threadId) return;
    if (isNumericThreadRouteId(threadId) && !isProjectResolved) {
      setNotFound(false);
      setDetail(null);
      return;
    }
    if (isNumericThreadRouteId(threadId) && !threadProjectId) {
      setDetail(null);
      setNotFound(true);
      return;
    }
    setNotFound(false);
    setDetail(null);

    const loadThread = async () => {
      const scopedPath = threadPathWithScope();
      if (!scopedPath) {
        setNotFound(true);
        return;
      }
      const res = await apiFetch(scopedPath, undefined, { auth: "optional" });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        throw new Error(await readError(res, "Failed to load thread"));
      }
      setDetail((await res.json()) as ThreadDetailPayload);
    };

    loadThread().catch(() => setNotFound(true));
  }, [threadId, apiFetch, isProjectResolved, threadPathWithScope, threadProjectId]);

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
      disableChatInputs
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
      onAddMatrixDoc={undefined}
      onRemoveMatrixDoc={undefined}
      onCreateMatrixDocument={undefined}
      onReplaceMatrixDocument={undefined}
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
                  messages: mergeChatMessages(prev.chat.messages, data.messages ?? []),
                },
              }
            : prev
        ));
        return data;
      }}
      onRunAssistant={async (payload) => {
        const assistantType = payload.mode === "plan" ? "plan" : "direct";
        const scopedRunPath = threadPathWithScope(`/assistants/${assistantType}/runs`);
        if (!scopedRunPath) {
          return { error: "Unable to determine thread context." };
        }
        const res = await apiFetch(
          scopedRunPath,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          return { error: await readError(res, "Failed to run assistant") };
        }
        const data = (await res.json()) as AssistantRunResponse;
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

        let threadState = data.threadState;
        if (
          payload.mode === "direct"
          && !threadState
          && typeof data.changesCount === "number"
          && data.changesCount > 0
        ) {
          const refreshed = await refreshThread();
          if (refreshed) {
            threadState = refreshed;
          }
        }

        setDetail((prev) => (
          prev
            ? {
                ...mergeThreadStateFromRun(prev, threadState),
                systemId: data.systemId ?? prev.systemId,
                chat: {
                  ...prev.chat,
                  messages: mergeChatMessages(prev.chat.messages, data.messages ?? []),
                },
              }
            : prev
        ));
        return data;
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
      onCloneThread={async (payload) => {
        const title = typeof payload?.title === "string" ? payload.title.trim() : "";
        const description = typeof payload?.description === "string" ? payload.description.trim() : "";
        try {
          const targetProjectId = await resolveThreadProjectId();
          if (!targetProjectId) {
            return { error: "Unable to determine project context." };
          }
          const res = await apiFetch(
            `/threads`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                projectId: targetProjectId,
                sourceThreadId: threadId,
                title,
                description,
              }),
            },
          );
          if (!res.ok) {
            return { error: await readError(res, "Failed to create thread") };
          }
          const data = (await res.json()) as V1ThreadListItem & { createdAt?: string };
          if (!data?.id) {
            return { error: "New thread not found" };
          }
          const created = toThreadDetailFromSummary(data, {
            id: targetProjectId,
            name: detail.thread.projectName ?? "",
            description: null,
            visibility: "private",
            accessRole: detail.thread.accessRole,
            ownerHandle: detail.thread.ownerHandle,
            createdAt: new Date().toISOString(),
            threadCount: 0,
          });
          onProjectMutated?.();
          const threadRouteId = data.projectThreadId != null ? String(data.projectThreadId) : data.id;
          navigate(`/${encodeURIComponent(handle!)}/${encodeURIComponent(projectName!)}/thread/${threadRouteId}`);
          return { thread: created };
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
  const activeProjectOwner = segments.length >= 2 && segments[0] !== "settings" ? segments[0] : undefined;
  const activeProjectName = segments.length >= 2 && segments[0] !== "settings" ? segments[1] : undefined;

  return (
    <>
      <NavigateSync />
      <Header onToggleSidebar={toggleSidebar} />
      <div className="app-layout">
        {isAuthenticated && (
          <Sidebar
            projects={projects}
            activeProjectOwner={activeProjectOwner}
            activeProjectName={activeProjectName}
            open={sidebarOpen}
          />
        )}
        <div className="app-content">
          <Routes>
            <Route path="/" element={<HomePage projects={projects} setProjects={setProjects} />} />
            <Route path="/:handle/:project" element={<ProjectRoute onProjectMutated={refreshProjects} />} />
            <Route path="/settings" element={<AccountSettingsRoute />} />
            <Route path="/:handle/:project/settings" element={<SettingsRoute onProjectMutated={refreshProjects} />} />
            <Route path="/:handle" element={<ProfileRoute />} />
            <Route path="/:handle/:project/thread/:threadId" element={<ThreadRoute onProjectMutated={refreshProjects} />} />
            <Route path="*" element={<NotFoundRoute />} />
          </Routes>
          <footer className="site-footer">
            Built by <a href="https://x.com/wutheringsf" target="_blank" rel="noreferrer">@wutheringsf</a>
          </footer>
        </div>
      </div>
    </>
  );
}

export function App() {
  const { isAuthenticated, isLoading, loginWithRedirect, logout } = useAuth0();
  const apiFetch = useApi();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsKey, setProjectsKey] = useState(0);

  const refreshProjects = useCallback(() => setProjectsKey((k) => k + 1), []);

  useEffect(() => {
    if (!isAuthenticated) return;
    apiFetch("/projects", undefined, { auth: "optional" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as V1ProjectListResponse;
        const payload = toEnvelopePayload(data);
        setProjects(payload.items.map((project) => normalizeProject(project)));
      })
      .catch((error) => {
        console.error("Project fetch failed:", error);
      });
  }, [apiFetch, isAuthenticated, projectsKey]);

  useEffect(() => {
    if (!isAuthenticated) {
      setUser(null);
      return;
    }

    apiFetch("/me")
      .then(async (response) => {
        if (!response.ok) return;
        const me = await response.json();
        setUser({ handle: me.handle, email: me.email ?? null, githubHandle: me.githubHandle ?? "", name: me.name, picture: me.picture });
      })
      .catch((error) => {
        console.error("Profile fetch failed:", error);
      });
  }, [apiFetch, isAuthenticated]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        user,
        login: () => loginWithRedirect(),
        logout: () => logout({ logoutParams: { returnTo: window.location.origin } }),
      }}
    >
      <BrowserRouter>
        <AppShell projects={projects} setProjects={setProjects} isAuthenticated={isAuthenticated} refreshProjects={refreshProjects} />
      </BrowserRouter>
    </AuthContext.Provider>
  );
}
