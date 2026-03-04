import { useState, useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { useAuth } from "./auth-context";
import { Link } from "./link";

export type ThreadStatus = "open" | "closed" | "committed";
export type ProjectVisibility = "public" | "private";

export const isFinalizedThreadStatus = (status: ThreadStatus): boolean =>
  status === "closed" || status === "committed";

export interface Thread {
  id: string;
  projectThreadId?: number | null;
  title: string | null;
  description: string | null;
  status: ThreadStatus;
  sourceThreadId?: string | null;
  createdBy?: string;
  createdAt?: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  accessRole: string;
  visibility: ProjectVisibility;
  ownerHandle: string;
  createdAt: string;
  threads: Thread[];
}

const TEMPLATES = [
  { id: "blank", label: "Blank", description: "Empty project, start from scratch" },
  {
    id: "staffx-openship-bundle-import",
    label: "StaffX OpenShip runtime import",
    description: "Imports the canonical OpenShip bundle from ./openship into the project",
  },
  {
    id: "webserver-postgres-auth0-google-vercel",
    label: "Webserver + Postgres + Auth0 Google login + Vercel",
    description: "Seeded stack with topology, architecture concern, and spec docs",
  },
];

interface CreateModalProps {
  onClose: () => void;
  onCreate: (data: {
    name: string;
    description: string;
    template: string;
    visibility: ProjectVisibility;
  }) => Promise<{ error?: string } | void>;
  onCheckName?: (name: string) => Promise<boolean>;
}

function CreateProjectModal({ onClose, onCreate, onCheckName }: CreateModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState("blank");
  const [visibility, setVisibility] = useState<ProjectVisibility | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [duplicateError, setDuplicateError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const nameTrimmed = name.trim();
  const nameValid = /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(nameTrimmed) && !/[-_]{2}/.test(nameTrimmed);
  const formatError = nameTrimmed.length > 0 && !nameValid
    ? "Letters and numbers only, no leading/trailing - or _, no consecutive - or _"
    : name.length > 0 && name !== nameTrimmed
      ? "No spaces at the beginning or end"
      : "";
  const nameError = formatError || duplicateError;
  const canSubmit = nameTrimmed.length > 0 && nameValid && name === nameTrimmed && !submitting && !duplicateError && !!visibility;

  useEffect(() => {
    setDuplicateError("");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!nameTrimmed || !nameValid || !onCheckName) return;
    const currentName = nameTrimmed;
    debounceRef.current = setTimeout(async () => {
      const available = await onCheckName(currentName);
      if (!available) setDuplicateError("A project with this name already exists");
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [nameTrimmed, nameValid, onCheckName]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError("");
    if (!visibility) return;
    const result = await onCreate({ name: name.trim(), description: description.trim(), template, visibility });
    if (result?.error) {
      setSubmitError(result.error);
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h3 className="modal-title">Project Creation</h3>

        <label className="field">
          <span className="field-label">Name</span>
          <input
            className={`field-input${nameError ? " field-input--error" : ""}`}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-project"
            autoFocus
          />
          {nameError && <span className="field-error">{nameError}</span>}
        </label>

        <fieldset className="field">
          <span className="field-label">Template</span>
          <div className="template-list">
            {TEMPLATES.map((t) => (
              <label
                key={t.id}
                className={`template-option${template === t.id ? " template-option--selected" : ""}`}
              >
                <input
                  type="radio"
                  name="template"
                  value={t.id}
                  checked={template === t.id}
                  onChange={() => setTemplate(t.id)}
                />
                <span className="template-option-label">{t.label}</span>
                <span className="template-option-desc">{t.description}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span className="field-label">Description</span>
          <textarea
            className="field-input field-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            rows={3}
          />
        </label>

        <fieldset className="field">
          <span className="field-label">Visibility</span>
          <div className="template-list">
            <label className={`template-option${visibility === "private" ? " template-option--selected" : ""}`}>
              <input
                type="radio"
                name="visibility"
                value="private"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
              />
              <span className="template-option-label">Private</span>
              <span className="template-option-desc">Only owner and contributors can view.</span>
            </label>
            <label className={`template-option${visibility === "public" ? " template-option--selected" : ""}`}>
              <input
                type="radio"
                name="visibility"
                value="public"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
              />
              <span className="template-option-label">Public</span>
              <span className="template-option-desc">Anyone can view, only owner/editors can modify.</span>
            </label>
          </div>
        </fieldset>

        {submitError && <p className="field-error">{submitError}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface HomeProps {
  projects: Project[];
  onCreateProject?: (data: {
    name: string;
    description: string;
    template: string;
    visibility: ProjectVisibility;
  }) => Promise<{ error?: string } | void>;
  onCheckProjectName?: (name: string) => Promise<boolean>;
}

export function Home({ projects, onCreateProject, onCheckProjectName }: HomeProps) {
  const { isAuthenticated, isLoading, login } = useAuth();
  const [showCreate, setShowCreate] = useState(false);

  if (isLoading) {
    return (
      <main className="main">
        <p className="status-text">Loading…</p>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="hero">
        <h1 className="hero-tagline">A flight simulator for your AI-generated software.</h1>
        <button className="btn hero-cta" onClick={login}>Log In</button>
        <p style={{ textAlign: "center" }}>
          <i>
            StaffX is the human control plane for AI-generated software:<br />
            it lets domain experts go from a product description to a deployed,
            maintainable system<br />
            using curated reference architectures, with visual preview, and<br />
            simulation, and risk scoring that keep the system understandable and safe
            to change as it evolves.
          </i>
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page-header">
        <h2 className="page-title">Projects</h2>
        <button
          className="btn-icon btn-icon-round"
          onClick={() => setShowCreate(true)}
          aria-label="New project"
        >
          <Plus size={16} />
        </button>
      </div>
      {projects.length === 0 ? (
        <p className="status-text">No projects yet</p>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <Link key={p.id} to={`/${p.ownerHandle}/${p.name}`} className="project-card">
              <div className="project-card-name">
                {p.ownerHandle} / {p.name}
              </div>
              <span className="project-card-role">{p.accessRole} · {p.visibility}</span>
              {p.threads.length > 0 && (
                <ul className="project-card-threads">
                  {p.threads.map((t) => (
                    <li key={t.id}>
                      {t.title ?? "Untitled thread"}
                    </li>
                  ))}
                </ul>
              )}
            </Link>
          ))}
        </div>
      )}
      {showCreate && (
        <CreateProjectModal
          onClose={() => setShowCreate(false)}
          onCheckName={onCheckProjectName}
          onCreate={async (data) => {
            const result = await onCreateProject?.(data);
            if (result?.error) return result;
            setShowCreate(false);
          }}
        />
      )}
    </main>
  );
}
