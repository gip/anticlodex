import { useState } from "react";
import { Settings } from "lucide-react";
import { Link } from "./link";
import { isFinalizedThreadStatus, type Project, type Thread } from "./home";
import type { ThreadDetail } from "./thread-page";
import { renderMarkdown } from "./markdown";

interface MutationError {
  error: string;
}

type MutationResult<T> = T | MutationError | void;

interface ProjectPageProps {
  project: Project;
  fromThreadId?: string | null;
  onCloseThread?: (threadId: string) => Promise<MutationResult<{ thread: ThreadDetail }>>;
  onCommitThread?: (threadId: string) => Promise<MutationResult<{ thread: ThreadDetail }>>;
  onUpdateDescription?: (description: string | null) => Promise<MutationResult<{ description: string | null }>>;
  onCloneThread?: (
    threadId: string,
    payload: {
      title: string;
      description: string;
    },
  ) => Promise<MutationResult<{ thread: ThreadDetail }>>;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function getErrorMessage<T>(result: MutationResult<T>): string | null {
  if (!result || typeof result !== "object") return null;
  const normalized = result as Partial<MutationError>;
  if (typeof normalized.error === "string") return normalized.error;
  return null;
}

function flattenThreadTree(threads: Thread[], fromProjectThreadId?: string | null): Array<{ thread: Thread; depth: number }> {
  const getThreadRouteId = (thread: Thread): string => (
    thread.projectThreadId != null ? String(thread.projectThreadId) : thread.id
  );
  const threadIds = new Set(threads.map((t) => t.id));
  const childrenMap = new Map<string, Thread[]>();
  const roots: Thread[] = [];

  for (const t of threads) {
    const parentId = t.sourceThreadId;
    if (parentId && threadIds.has(parentId)) {
      if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
      childrenMap.get(parentId)!.push(t);
    } else {
      roots.push(t);
    }
  }

  const result: Array<{ thread: Thread; depth: number }> = [];
  function walk(nodes: Thread[], depth: number) {
    for (const node of nodes) {
      result.push({ thread: node, depth });
      const children = childrenMap.get(node.id);
      if (children) walk(children, depth + 1);
    }
  }

  if (fromProjectThreadId != null) {
    const startThread = threads.find((t) => getThreadRouteId(t) === fromProjectThreadId);
    if (startThread) {
      walk([startThread], 0);
      return result;
    }
  }

  walk(roots, 0);
  return result;
}

export function ProjectPage({
  project,
  fromThreadId,
  onCloseThread,
  onCommitThread,
  onUpdateDescription,
  onCloneThread,
}: ProjectPageProps) {
  const [cloningThreadId, setCloningThreadId] = useState<string | null>(null);
  const [threadTransitionThreadId, setThreadTransitionThreadId] = useState<string | null>(null);
  const [threadTransitionAction, setThreadTransitionAction] = useState<"close" | "commit" | null>(null);
  const [cloneErrors, setCloneErrors] = useState<Record<string, string>>({});
  const [threadTransitionErrors, setThreadTransitionErrors] = useState<Record<string, string>>({});
  const [cloneThreadDraft, setCloneThreadDraft] = useState<Thread | null>(null);
  const [cloneThreadTitle, setCloneThreadTitle] = useState("");
  const [cloneThreadDescription, setCloneThreadDescription] = useState("");
  const [isSubmittingClone, setIsSubmittingClone] = useState(false);
  const canCloneThreads = project.accessRole === "Owner" || project.accessRole === "Editor";
  const canEditDescription = (project.accessRole === "Owner" || project.accessRole === "Editor") && !!onUpdateDescription;
  const [isDescriptionEditing, setIsDescriptionEditing] = useState(false);
  const [descriptionTab, setDescriptionTab] = useState<"write" | "preview">("write");
  const [descriptionDraft, setDescriptionDraft] = useState(project.description ?? "");
  const [descriptionError, setDescriptionError] = useState("");
  const [isSavingDescription, setIsSavingDescription] = useState(false);

  async function handleSaveDescription() {
    if (!onUpdateDescription) return;
    setDescriptionError("");
    setIsSavingDescription(true);
    const nextDescription = descriptionDraft.trim() ? descriptionDraft.trim() : null;
    try {
      const result = await onUpdateDescription(nextDescription);
      const error = getErrorMessage(result);
      if (error) {
        setDescriptionError(error);
        return;
      }
      setDescriptionDraft(nextDescription ?? "");
      setIsDescriptionEditing(false);
    } catch {
      setDescriptionError("Failed to update project description");
    } finally {
      setIsSavingDescription(false);
    }
  }

  return (
    <main className="page">
      <div className="page-header">
        <Link to="/" className="page-back">&larr;</Link>
        <h2 className="page-title">
          <span className="page-title-muted">{project.ownerHandle} / </span>
          {project.name}
        </h2>
        <div className="page-header-actions">
          <Link to={`/${project.ownerHandle}/${project.name}/settings`} className="btn-icon">
            <Settings size={16} />
          </Link>
        </div>
      </div>

      <section className="project-description-card">
        {isDescriptionEditing ? (
          <div className="project-description-editor">
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
                placeholder="Add a project description (Markdown supported)"
              />
            ) : (
              <div className="md-preview">
                {descriptionDraft.trim() ? (
                  <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(descriptionDraft) }} />
                ) : (
                  <p className="project-description-empty">Nothing to preview</p>
                )}
              </div>
            )}
            {descriptionError && <p className="field-error">{descriptionError}</p>}
            <div className="thread-inline-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setDescriptionDraft(project.description ?? "");
                  setDescriptionError("");
                  setDescriptionTab("write");
                  setIsDescriptionEditing(false);
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn" disabled={isSavingDescription} onClick={handleSaveDescription}>
                {isSavingDescription ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div className="project-description-display">
            <div className="project-description-content">
              {project.description ? (
                <div className="md-body project-description-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(project.description) }} />
              ) : (
                <p className="project-description-empty">
                  {canEditDescription
                    ? <em>No description yet. Click Edit to add one.</em>
                    : "No description provided yet."}
                </p>
              )}
            </div>
            {canEditDescription && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setDescriptionDraft(project.description ?? "");
                  setDescriptionError("");
                  setDescriptionTab("write");
                  setIsDescriptionEditing(true);
                }}
              >
                Edit
              </button>
            )}
          </div>
        )}
      </section>

      <section className="thread-section">
        <h3 className="thread-section-title">Threads</h3>
        {(() => {
          const flatThreads = flattenThreadTree(project.threads, fromThreadId);
          const isFiltered = fromThreadId != null && flatThreads.length < project.threads.length;
          return project.threads.length === 0 ? (
            <p className="status-text">No threads yet</p>
          ) : (
            <>
              {isFiltered && (
                <p className="thread-filter-info">
                  Showing threads from #{fromThreadId} &mdash;{" "}
                  <Link to={`/${project.ownerHandle}/${project.name}`}>Show all</Link>
                </p>
              )}
              <div className="thread-list">
                {flatThreads.map(({ thread: t, depth }) => {
                  const threadRouteId = t.projectThreadId != null ? String(t.projectThreadId) : t.id;
                  const threadDisplayId = t.projectThreadId != null ? threadRouteId : t.id.slice(0, 8);

                  return (
                    <Link
                      key={t.id}
                      to={`/${project.ownerHandle}/${project.name}/thread/${threadRouteId}`}
                      className={`thread-row${depth > 0 ? " thread-row--nested" : ""}`}
                      style={depth > 0 ? { paddingLeft: `${16 + depth * 24}px` } : undefined}
                    >
                      <span className="thread-row-main">
                        <span className="thread-row-id">#{threadDisplayId}</span>
                        <span className="thread-row-title">{t.title ?? "Untitled"}</span>
                        {(project.accessRole === "Owner" || project.accessRole === "Editor") && t.status === "open" && onCloseThread && onCommitThread && (
                          <>
                            <button
                              className="btn btn-secondary thread-row-action-button"
                              type="button"
                              disabled={threadTransitionThreadId === t.id}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                const threadProjectId = t.id;
                                const threadId = t.id;
                                setThreadTransitionThreadId(threadId);
                                setThreadTransitionAction("close");
                                setThreadTransitionErrors((prev) => {
                                  const next = { ...prev };
                                  delete next[threadId];
                                  return next;
                                });
                                (async () => {
                                  try {
                                    const result = await onCloseThread(threadProjectId);
                                    const error = getErrorMessage(result);
                                    if (error) {
                                      setThreadTransitionErrors((prev) => ({ ...prev, [threadId]: error }));
                                    }
                                  } catch {
                                    setThreadTransitionErrors((prev) => ({ ...prev, [threadId]: "Failed to close thread" }));
                                  } finally {
                                    setThreadTransitionThreadId((current) => (current === threadId ? null : current));
                                    setThreadTransitionAction(null);
                                  }
                                })();
                              }}
                            >
                              {threadTransitionThreadId === t.id && threadTransitionAction === "close"
                                ? "Closing…"
                                : "Close"}
                            </button>
                            <button
                              className="btn thread-row-action-button"
                              type="button"
                              disabled={threadTransitionThreadId === t.id}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                const threadProjectId = t.id;
                                const threadId = t.id;
                                setThreadTransitionThreadId(threadId);
                                setThreadTransitionAction("commit");
                                setThreadTransitionErrors((prev) => {
                                  const next = { ...prev };
                                  delete next[threadId];
                                  return next;
                                });
                                (async () => {
                                  try {
                                    const result = await onCommitThread(threadProjectId);
                                    const error = getErrorMessage(result);
                                    if (error) {
                                      setThreadTransitionErrors((prev) => ({ ...prev, [threadId]: error }));
                                    }
                                  } catch {
                                    setThreadTransitionErrors((prev) => ({ ...prev, [threadId]: "Failed to commit thread" }));
                                  } finally {
                                    setThreadTransitionThreadId((current) => (current === threadId ? null : current));
                                    setThreadTransitionAction(null);
                                  }
                                })();
                              }}
                            >
                              {threadTransitionThreadId === t.id && threadTransitionAction === "commit"
                                ? "Committing…"
                                : "Commit"}
                            </button>
                          </>
                        )}
                        {canCloneThreads && isFinalizedThreadStatus(t.status) && onCloneThread && (
                          <button
                            className="btn btn-secondary thread-row-action-button thread-row-clone-action"
                            type="button"
                            disabled={cloningThreadId === t.id}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setCloneThreadDraft(t);
                              setCloneThreadTitle(t.title ?? "");
                              setCloneThreadDescription(t.description ?? "");
                              setCloneErrors((prev) => {
                                const next = { ...prev };
                                delete next[t.id];
                                return next;
                              });
                            }}
                          >
                            {cloningThreadId === t.id ? "Creating…" : "New Thread"}
                          </button>
                        )}
                        <span className={`thread-status thread-status--${t.status === "committed" ? "committed" : t.status} thread-row-status`}>
                          {t.status === "open" ? "Open" : t.status === "closed" ? "Closed" : t.status}
                        </span>
                        <span className="thread-row-date">{formatDate(t.updatedAt)}</span>
                      </span>
                      {cloneErrors[t.id] && (
                        <span className="thread-row-actions thread-row-error">
                          <p className="field-error">{cloneErrors[t.id]}</p>
                        </span>
                      )}
                      {threadTransitionErrors[t.id] && (
                        <span className="thread-row-actions thread-row-error">
                          <p className="field-error">{threadTransitionErrors[t.id]}</p>
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </>
          );
        })()}
      </section>

      {cloneThreadDraft && onCloneThread && (
        <div
          className="modal-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isSubmittingClone) {
              setCloneThreadDraft(null);
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
                value={cloneThreadTitle}
                onChange={(event) => setCloneThreadTitle(event.target.value)}
                disabled={isSubmittingClone}
              />
            </label>
            <label className="field">
              <span className="field-label">Description</span>
              <textarea
                className="field-input field-textarea"
                rows={5}
                value={cloneThreadDescription}
                onChange={(event) => setCloneThreadDescription(event.target.value)}
                disabled={isSubmittingClone}
              />
            </label>
            {cloneErrors[cloneThreadDraft.id] && <p className="field-error">{cloneErrors[cloneThreadDraft.id]}</p>}
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                type="button"
                disabled={isSubmittingClone}
                onClick={() => setCloneThreadDraft(null)}
              >
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={isSubmittingClone || !cloneThreadTitle.trim()}
                onClick={async () => {
                  const draft = cloneThreadDraft;
                  if (!draft) return;
                  const title = cloneThreadTitle.trim();
                  const description = cloneThreadDescription.trim();
                  if (!title) return;
                  setIsSubmittingClone(true);
                  setCloningThreadId(draft.id);
                  setCloneErrors((prev) => {
                    const next = { ...prev };
                    delete next[draft.id];
                    return next;
                  });
                  try {
                    const result = await onCloneThread(draft.id, {
                      title,
                      description,
                    });
                    const error = getErrorMessage(result);
                    if (error) {
                      setCloneErrors((prev) => ({ ...prev, [draft.id]: error }));
                    } else {
                      setCloneThreadDraft(null);
                      setCloneThreadDescription("");
                      setCloneThreadTitle("");
                    }
                  } catch {
                    setCloneErrors((prev) => ({ ...prev, [draft.id]: "Failed to create thread" }));
                  } finally {
                    setCloningThreadId((current) => (current === draft.id ? null : current));
                    setIsSubmittingClone(false);
                  }
                }}
              >
                {isSubmittingClone ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
