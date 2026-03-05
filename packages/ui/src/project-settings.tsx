import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "./link";

export interface Collaborator {
  handle: string;
  name: string | null;
  picture: string | null;
  role: string;
  projectRoles: string[];
}

export interface SearchResult {
  handle: string;
  name: string | null;
  picture: string | null;
}

export interface Concern {
  name: string;
  position: number;
  isBaseline: boolean;
  scope: string | null;
}

interface ProjectSettingsPageProps {
  projectOwnerHandle: string;
  projectName: string;
  accessRole: string;
  visibility: "public" | "private";
  collaborators: Collaborator[];
  projectRoles: string[];
  concerns: Concern[];
  onSearchUsers: (q: string) => Promise<SearchResult[]>;
  onAddCollaborator: (handle: string, role: string, projectRoles: string[]) => Promise<{ error?: string } | void>;
  onRemoveCollaborator: (handle: string) => Promise<{ error?: string } | void>;
  onAddRole: (name: string) => Promise<{ error?: string } | void>;
  onDeleteRole: (name: string) => Promise<{ error?: string } | void>;
  onAddConcern: (name: string) => Promise<{ error?: string } | void>;
  onDeleteConcern: (name: string) => Promise<{ error?: string } | void>;
  onUpdateMemberRoles: (handle: string, projectRoles: string[]) => Promise<{ error?: string } | void>;
  onUpdateVisibility: (visibility: "public" | "private") => Promise<{ error?: string } | void>;
  onArchiveProject: () => Promise<{ error?: string } | void>;
}

export function ProjectSettingsPage({
  projectOwnerHandle,
  projectName,
  accessRole,
  visibility,
  collaborators: initial,
  projectRoles: initialRoles,
  concerns: initialConcerns,
  onSearchUsers,
  onAddCollaborator,
  onRemoveCollaborator,
  onAddRole,
  onDeleteRole,
  onAddConcern,
  onDeleteConcern,
  onUpdateMemberRoles,
  onUpdateVisibility,
  onArchiveProject,
}: ProjectSettingsPageProps) {
  const [collaborators, setCollaborators] = useState(initial);
  const [projectRoles, setProjectRoles] = useState(initialRoles);
  const [concerns, setConcerns] = useState(initialConcerns);
  const [showAdd, setShowAdd] = useState(false);
  const [editingMember, setEditingMember] = useState<Collaborator | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [newRoleName, setNewRoleName] = useState("");
  const [roleError, setRoleError] = useState<string | null>(null);
  const [addingRole, setAddingRole] = useState(false);
  const [newConcernName, setNewConcernName] = useState("");
  const [concernError, setConcernError] = useState<string | null>(null);
  const [addingConcern, setAddingConcern] = useState(false);
  const [currentVisibility, setCurrentVisibility] = useState<"public" | "private">(visibility);
  const [visibilityDraft, setVisibilityDraft] = useState<"public" | "private">(visibility);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [isSavingVisibility, setIsSavingVisibility] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const isOwner = accessRole === "Owner";

  useEffect(() => {
    setCurrentVisibility(visibility);
    setVisibilityDraft(visibility);
  }, [visibility]);

  const handleRemove = useCallback(
    async (handle: string) => {
      setRemoving(handle);
      const res = await onRemoveCollaborator(handle);
      if (!res || !res.error) {
        setCollaborators((prev) => prev.filter((c) => c.handle !== handle));
      }
      setRemoving(null);
    },
    [onRemoveCollaborator],
  );

  const handleAdd = useCallback(
    async (handle: string, role: string, roles: string[]) => {
      const res = await onAddCollaborator(handle, role, roles);
      if (res && res.error) return res;
      setShowAdd(false);
      setCollaborators((prev) => {
        if (prev.some((c) => c.handle === handle)) return prev;
        return [...prev, { handle, name: null, picture: null, role, projectRoles: roles }];
      });
    },
    [onAddCollaborator],
  );

  const handleAddRole = useCallback(async () => {
    if (!newRoleName.trim()) return;
    setAddingRole(true);
    setRoleError(null);
    const res = await onAddRole(newRoleName.trim());
    if (res && res.error) {
      setRoleError(res.error);
    } else {
      setProjectRoles((prev) => [...prev, newRoleName.trim()]);
      setNewRoleName("");
    }
    setAddingRole(false);
  }, [newRoleName, onAddRole]);

  const handleDeleteRole = useCallback(async (name: string) => {
    setRoleError(null);
    const res = await onDeleteRole(name);
    if (res && res.error) {
      setRoleError(res.error);
    } else {
      setProjectRoles((prev) => prev.filter((r) => r !== name));
    }
  }, [onDeleteRole]);

  const handleAddConcern = useCallback(async () => {
    if (!newConcernName.trim()) return;
    setAddingConcern(true);
    setConcernError(null);
    const trimmed = newConcernName.trim();
    const res = await onAddConcern(trimmed);
    if (res && res.error) {
      setConcernError(res.error);
    } else {
      setConcerns((prev) => {
        const nextPosition = prev.reduce((max, concern) => Math.max(max, concern.position), -1) + 1;
        return [...prev, { name: trimmed, position: nextPosition, isBaseline: false, scope: null }];
      });
      setNewConcernName("");
    }
    setAddingConcern(false);
  }, [newConcernName, onAddConcern]);

  const handleDeleteConcern = useCallback(async (name: string) => {
    setConcernError(null);
    const res = await onDeleteConcern(name);
    if (res && res.error) {
      setConcernError(res.error);
    } else {
      setConcerns((prev) => prev.filter((concern) => concern.name !== name));
    }
  }, [onDeleteConcern]);

  const handleUpdateMemberRoles = useCallback(
    async (handle: string, roles: string[]) => {
      const res = await onUpdateMemberRoles(handle, roles);
      if (res && res.error) return res;
      setEditingMember(null);
      setCollaborators((prev) =>
        prev.map((c) => (c.handle === handle ? { ...c, projectRoles: roles } : c)),
      );
    },
    [onUpdateMemberRoles],
  );

  const handleSaveVisibility = useCallback(async () => {
    if (visibilityDraft === currentVisibility) return;
    setVisibilityError(null);
    setIsSavingVisibility(true);
    const result = await onUpdateVisibility(visibilityDraft);
    if (result?.error) {
      setVisibilityError(result.error);
    } else {
      setCurrentVisibility(visibilityDraft);
    }
    setIsSavingVisibility(false);
  }, [currentVisibility, onUpdateVisibility, visibilityDraft]);

  const handleArchive = useCallback(async () => {
    if (!isOwner) return;
    setIsArchiving(true);
    setArchiveError(null);
    const result = await onArchiveProject();
    if (result?.error) {
      setArchiveError(result.error);
    } else {
      setShowArchiveModal(false);
    }
    setIsArchiving(false);
  }, [isOwner, onArchiveProject]);

  const openArchiveModal = useCallback(() => {
    setArchiveError(null);
    setShowArchiveModal(true);
  }, []);

  const closeArchiveModal = useCallback(() => {
    setShowArchiveModal(false);
    setArchiveError(null);
  }, []);

  return (
    <main className="page project-settings">
      <div className="page-header">
        <Link to={`/${projectOwnerHandle}/${projectName}`} className="page-back">
          &larr;
        </Link>
        <h2 className="page-title">
          <span className="page-title-muted">{projectOwnerHandle} / {projectName} / </span>
          Settings
        </h2>
      </div>

      <section className="thread-section">
        <h3 className="thread-section-title">Visibility</h3>
        {isOwner ? (
          <div className="roles-add-form">
            <select
              className="field-input roles-add-input"
              value={visibilityDraft}
              onChange={(event) => setVisibilityDraft(event.target.value as "public" | "private")}
            >
              <option value="private">private</option>
              <option value="public">public</option>
            </select>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={isSavingVisibility || visibilityDraft === currentVisibility}
              onClick={handleSaveVisibility}
            >
              {isSavingVisibility ? "Saving..." : "Save"}
            </button>
          </div>
        ) : (
          <p className="status-text">{currentVisibility}</p>
        )}
        {visibilityError && <p className="field-error">{visibilityError}</p>}
      </section>

      {/* Roles section */}
      <section className="thread-section">
        <h3 className="thread-section-title">Roles</h3>
        <div className="roles-list">
          {projectRoles.map((r) => (
            <span key={r} className="role-tag">
              {r}
              {isOwner && (
                <button
                  className="role-tag-remove"
                  onClick={() => handleDeleteRole(r)}
                  title={`Remove ${r}`}
                >
                  &times;
                </button>
              )}
            </span>
          ))}
        </div>
        {isOwner && (
          <form
            className="roles-add-form"
            onSubmit={(e) => { e.preventDefault(); handleAddRole(); }}
          >
            <input
              className="field-input roles-add-input"
              placeholder="New role name…"
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
            />
            <button className="btn btn-secondary" type="submit" disabled={addingRole || !newRoleName.trim()}>
              Add
            </button>
          </form>
        )}
        {roleError && <p className="field-error">{roleError}</p>}
      </section>

      {/* Concerns section */}
      <section className="thread-section">
        <h3 className="thread-section-title">Concerns</h3>
        <div className="concerns-list">
          {concerns.map((concern) => (
            <span key={concern.name} className="concern-tag">
              {concern.name}
              {isOwner && (
                <button
                  className="concern-tag-remove"
                  onClick={() => handleDeleteConcern(concern.name)}
                  title={`Remove ${concern.name}`}
                >
                  &times;
                </button>
              )}
            </span>
          ))}
        </div>
        {isOwner && (
          <form
            className="roles-add-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleAddConcern();
            }}
          >
            <input
              className="field-input roles-add-input"
              placeholder="New concern…"
              value={newConcernName}
              onChange={(e) => setNewConcernName(e.target.value)}
            />
            <button className="btn btn-secondary" type="submit" disabled={addingConcern || !newConcernName.trim()}>
              Add
            </button>
          </form>
        )}
        {concernError && <p className="field-error">{concernError}</p>}
      </section>

      {/* Contributors section */}
      <section className="thread-section">
        <div className="collab-section-header">
          <h3 className="thread-section-title">Contributors</h3>
          {isOwner && (
            <button className="btn btn-secondary" onClick={() => setShowAdd(true)}>
              Add
            </button>
          )}
        </div>

        <div className="collab-list">
          {collaborators.map((c) => (
            <div key={c.handle} className="collab-row">
              {c.picture ? (
                <img src={c.picture} alt="" className="collab-avatar" />
              ) : (
                <div className="collab-avatar collab-avatar-fallback">
                  {(c.name ?? c.handle).charAt(0).toUpperCase()}
                </div>
              )}
              <div className="collab-info">
                <span className="collab-name">{c.name ?? c.handle}</span>
                <span className="collab-handle">@{c.handle}</span>
              </div>
              <span className="collab-role">{c.role}</span>
              <div className="collab-project-roles">
                {c.projectRoles.map((r) => (
                  <span key={r} className="role-tag role-tag-small">{r}</span>
                ))}
              </div>
              {isOwner && (
                <button
                  className="btn btn-secondary collab-remove"
                  onClick={() => setEditingMember(c)}
                >
                  Edit
                </button>
              )}
              {isOwner && c.role !== "Owner" && (
                <button
                  className="btn btn-secondary collab-remove"
                  disabled={removing === c.handle}
                  onClick={() => handleRemove(c.handle)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {isOwner && (
        <section className="thread-section">
          <h3 className="thread-section-title">Danger</h3>
          <button
            className="btn btn-danger"
            type="button"
            onClick={openArchiveModal}
            disabled={isArchiving}
          >
            {isArchiving ? "Archiving…" : "Archive"}
          </button>
        </section>
      )}

      {showAdd && (
        <AddCollaboratorModal
          onSearch={onSearchUsers}
          onAdd={handleAdd}
          onClose={() => setShowAdd(false)}
          existingHandles={new Set(collaborators.map((c) => c.handle))}
          projectRoles={projectRoles}
        />
      )}

      {editingMember && (
        <EditMemberRolesModal
          member={editingMember}
          projectRoles={projectRoles}
          onSave={handleUpdateMemberRoles}
          onClose={() => setEditingMember(null)}
        />
      )}

      {showArchiveModal && (
        <ArchiveProjectModal
          onClose={closeArchiveModal}
          onArchive={handleArchive}
          isLoading={isArchiving}
          error={archiveError}
        />
      )}
    </main>
  );
}

function AddCollaboratorModal({
  onSearch,
  onAdd,
  onClose,
  existingHandles,
  projectRoles,
}: {
  onSearch: (q: string) => Promise<SearchResult[]>;
  onAdd: (handle: string, role: string, projectRoles: string[]) => Promise<{ error?: string } | void>;
  onClose: () => void;
  existingHandles: Set<string>;
  projectRoles: string[];
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [role, setRole] = useState("Editor");
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(
    () => new Set(projectRoles.includes("All") ? ["All"] : projectRoles.slice(0, 1)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const res = await onSearch(query.trim());
      setResults(res.filter((r) => !existingHandles.has(r.handle)));
    }, 250);

    return () => clearTimeout(debounceRef.current);
  }, [query, onSearch, existingHandles]);

  const toggleRole = (name: string) => {
    setSelectedRoles((prev) => {
      if (name === "All") {
        return prev.has("All") ? prev : new Set(["All"]);
      }
      const next = new Set(prev);
      next.delete("All");
      if (next.has(name)) {
        if (next.size > 1) next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!selected || selectedRoles.size === 0) return;
    setSubmitting(true);
    setError(null);
    const res = await onAdd(selected.handle, role, [...selectedRoles]);
    if (res && res.error) {
      setError(res.error);
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Add collaborator</h3>

        <fieldset className="field">
          <label className="field-label">Search users</label>
          <input
            className="field-input"
            placeholder="Name or handle…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            autoFocus
          />
        </fieldset>

        {selected ? (
          <div className="collab-selected">
            {selected.picture ? (
              <img src={selected.picture} alt="" className="collab-avatar" />
            ) : (
              <div className="collab-avatar collab-avatar-fallback">
                {(selected.name ?? selected.handle).charAt(0).toUpperCase()}
              </div>
            )}
            <span className="collab-name">{selected.name ?? selected.handle}</span>
            <span className="collab-handle">@{selected.handle}</span>
          </div>
        ) : results.length > 0 ? (
          <div className="collab-search-results">
            {results.map((r) => (
              <button
                key={r.handle}
                className="collab-search-row"
                onClick={() => {
                  setSelected(r);
                  setResults([]);
                }}
              >
                {r.picture ? (
                  <img src={r.picture} alt="" className="collab-avatar" />
                ) : (
                  <div className="collab-avatar collab-avatar-fallback">
                    {(r.name ?? r.handle).charAt(0).toUpperCase()}
                  </div>
                )}
                <span className="collab-name">{r.name ?? r.handle}</span>
                <span className="collab-handle">@{r.handle}</span>
              </button>
            ))}
          </div>
        ) : null}

        <fieldset className="field">
          <label className="field-label">Access role</label>
          <select className="field-input" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="Editor">Editor</option>
            <option value="Viewer">Viewer</option>
          </select>
        </fieldset>

        <fieldset className="field">
          <label className="field-label">Project roles (at least 1)</label>
          <div className="role-checkbox-list">
            {projectRoles.map((r) => (
              <label key={r} className="role-checkbox-item">
                <input
                  type="checkbox"
                  checked={selectedRoles.has(r)}
                  onChange={() => toggleRole(r)}
                />
                {r}
              </label>
            ))}
          </div>
        </fieldset>

        {error && <p className="field-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={!selected || submitting || selectedRoles.size === 0}
            onClick={handleSubmit}
          >
            {submitting ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditMemberRolesModal({
  member,
  projectRoles,
  onSave,
  onClose,
}: {
  member: Collaborator;
  projectRoles: string[];
  onSave: (handle: string, roles: string[]) => Promise<{ error?: string } | void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(member.projectRoles));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (name: string) => {
    setSelected((prev) => {
      if (name === "All") {
        return prev.has("All") ? prev : new Set(["All"]);
      }
      const next = new Set(prev);
      next.delete("All");
      if (next.has(name)) {
        if (next.size > 1) next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    const res = await onSave(member.handle, [...selected]);
    if (res && res.error) {
      setError(res.error);
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Edit roles — {member.name ?? member.handle}</h3>

        <div className="role-checkbox-list">
          {projectRoles.map((r) => (
            <label key={r} className="role-checkbox-item">
              <input
                type="checkbox"
                checked={selected.has(r)}
                onChange={() => toggle(r)}
              />
              {r}
            </label>
          ))}
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={submitting || selected.size === 0}
            onClick={handleSave}
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ArchiveProjectModal({
  onClose,
  onArchive,
  isLoading,
  error,
}: {
  onClose: () => void;
  onArchive: () => Promise<void>;
  isLoading: boolean;
  error: string | null;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Archive repository?</h3>
        <p>This repo will be hidden from your project lists.</p>

        {error && <p className="field-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={isLoading}>
            Cancel
          </button>
          <button className="btn btn-danger" type="button" onClick={onArchive} disabled={isLoading}>
            {isLoading ? "Archiving…" : "Archive"}
          </button>
        </div>
      </div>
    </div>
  );
}
