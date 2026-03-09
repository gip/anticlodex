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
    id: "acx-openship-bundle-import",
    label: "AntiClodeX OpenShip runtime import",
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

const THREAD_PREVIEW_COUNT = 3;

export function Home({ projects, onCreateProject, onCheckProjectName }: HomeProps) {
  const { isAuthenticated, isLoading, login } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const projectCount = projects.length;
  const threadCount = projects.reduce((total, project) => total + project.threads.length, 0);
  const publicProjectCount = projects.filter((project) => project.visibility === "public").length;
  const privateProjectCount = projectCount - publicProjectCount;

  if (isLoading) {
    return (
      <main className="main">
        <p className="status-text">Loading…</p>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="hero home-landing">
        <section className="home-landing-panel" aria-labelledby="home-hero-title">
          <div className="home-landing-content">
            <h1 id="home-hero-title" className="hero-tagline">
              Correct AI-generated software.
            </h1>
            <p className="home-landing-copy">
              AntiClodeX is an experiment in helping teams build and maintain large software
              systems by making more of the engineering process visible—including system design,
              coding agents, simulation, and verification methods.
            </p>
            <div className="home-landing-actions">
              <button className="btn hero-cta" onClick={login}>Log In</button>
            </div>
          </div>
          <ul className="home-landing-highlights" aria-label="Core capabilities">
            <li className="home-highlight">
              <p className="home-highlight-title">Built for correctness at scale</p>
              <p className="home-highlight-body">
                AntiClodeX is designed to help teams build and maintain large software systems
                that behave as intended.
              </p>
            </li>
            <li className="home-highlight">
              <p className="home-highlight-title">System design and simulation</p>
              <p className="home-highlight-body">
                System topology can be inspected, and full-system behavior can be simulated before
                deployment—so teams can understand, test, and improve systems before they are
                trusted.
              </p>
            </li>
            <li className="home-highlight">
              <div className="home-highlight-title-row">
                <p className="home-highlight-title">Methods made visible</p>
                <span className="home-highlight-soon">Soon</span>
              </div>
              <p className="home-highlight-body">
                Coding agents, simulation, and formal methods should be visible parts of the
                engineering process, so teams can apply stronger methods to move systems toward
                correctness.
              </p>
            </li>
          </ul>
        </section>
      </main>
    );
  }

  return (
    <main className="page page-home">
      <section className="home-overview" aria-label="Projects overview">
        <div className="home-overview-main">
          <p className="home-overview-eyebrow">Workspace</p>
          <h1 className="page-title home-overview-title">Projects</h1>
          <p className="home-overview-subtitle">
            Explore active systems, review thread context, and start architecture work quickly.
          </p>
        </div>
        <div className="home-overview-actions">
          <button
            className="btn home-overview-create"
            onClick={() => setShowCreate(true)}
            aria-label="Create new project"
          >
            <Plus size={16} aria-hidden="true" />
            <span>New project</span>
          </button>
        </div>
        <ul className="home-stats" aria-label="Project statistics">
          <li className="home-stat">
            <span className="home-stat-value">{projectCount}</span>
            <span className="home-stat-label">Projects</span>
          </li>
          <li className="home-stat">
            <span className="home-stat-value">{threadCount}</span>
            <span className="home-stat-label">Threads</span>
          </li>
          <li className="home-stat">
            <span className="home-stat-value">{publicProjectCount}</span>
            <span className="home-stat-label">Public</span>
          </li>
          <li className="home-stat">
            <span className="home-stat-value">{privateProjectCount}</span>
            <span className="home-stat-label">Private</span>
          </li>
        </ul>
      </section>

      {projectCount === 0 ? (
        <section className="home-empty" aria-live="polite">
          <h2 className="home-empty-title">No projects yet</h2>
          <p className="home-empty-body">
            Create a project to define architecture concerns, run threads, and keep decisions auditable.
          </p>
          <button className="btn" onClick={() => setShowCreate(true)}>Create your first project</button>
        </section>
      ) : (
        <div className="project-grid project-grid--home">
          {projects.map((project) => {
            const visibleThreads = project.threads.slice(0, THREAD_PREVIEW_COUNT);
            const remainingThreadCount = Math.max(project.threads.length - THREAD_PREVIEW_COUNT, 0);
            const description = project.description?.trim();
            return (
              <Link key={project.id} to={`/${project.ownerHandle}/${project.name}`} className="project-card project-card--home">
                <div className="project-card-header">
                  <div className="project-card-name-group">
                    <p className="project-card-name">
                      {project.ownerHandle} / {project.name}
                    </p>
                    <p className="project-card-description">
                      {description?.length
                        ? description
                        : "No description yet. Open this project to document goals and architecture context."}
                    </p>
                  </div>
                  <div className="project-card-badges" aria-label="Project metadata">
                    <span className="project-badge">{project.accessRole}</span>
                    <span className="project-badge project-badge--muted">{project.visibility}</span>
                  </div>
                </div>
                <div className="project-card-thread-block">
                  <p className="project-card-thread-title">Recent threads</p>
                  {visibleThreads.length > 0 ? (
                    <ul className="project-card-threads">
                      {visibleThreads.map((thread) => (
                        <li key={thread.id} className="project-card-thread-item">
                          {thread.title ?? "Untitled thread"}
                        </li>
                      ))}
                      {remainingThreadCount > 0 && (
                        <li className="project-card-threads-more">{remainingThreadCount} more</li>
                      )}
                    </ul>
                  ) : (
                    <p className="project-card-threads-empty">No threads yet</p>
                  )}
                </div>
              </Link>
            );
          })}
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
