import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "./link";
import type { Project } from "./home";

export function Sidebar({
  projects,
  activeProjectOwner,
  activeProjectName,
  open,
}: {
  projects: Project[];
  activeProjectOwner?: string;
  activeProjectName?: string;
  open: boolean;
}) {
  const [manualExpanded, setManualExpanded] = useState<Record<string, boolean>>({});

  if (!open) return null;

  const isActiveProject = (p: Project) =>
    activeProjectOwner &&
    activeProjectName &&
    p.ownerHandle.toLowerCase() === activeProjectOwner.toLowerCase() &&
    p.name === activeProjectName;

  const isExpanded = (p: Project) => {
    const key = `${p.ownerHandle}/${p.name}`;
    if (key in manualExpanded) return manualExpanded[key];
    return !!isActiveProject(p);
  };

  const toggleProject = (p: Project) => {
    const key = `${p.ownerHandle}/${p.name}`;
    setManualExpanded((prev) => ({ ...prev, [key]: !isExpanded(p) }));
  };

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {projects.map((p) => {
          const expanded = isExpanded(p);
          const threadCount = p.threads.length;
          return (
            <div key={p.id} className="sidebar-project">
              <button
                className="sidebar-project-header"
                onClick={() => toggleProject(p)}
              >
                <ChevronRight
                  size={14}
                  className={`sidebar-chevron${expanded ? " sidebar-chevron--open" : ""}`}
                />
                <Link
                  to={`/${p.ownerHandle}/${p.name}`}
                  className="sidebar-project-link"
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                >
                  {p.ownerHandle} / {p.name}
                </Link>
                <span className="sidebar-project-count">{threadCount}</span>
              </button>
              {expanded && (
                <div className="sidebar-threads">
                  {p.threads.slice(0, 10).map((t) => (
                    <Link
                      key={t.id}
                      to={`/${p.ownerHandle}/${p.name}/thread/${t.projectThreadId ?? t.id}`}
                      className="sidebar-thread"
                    >
                      <span className="sidebar-thread-id">#{t.projectThreadId ?? `${t.id.slice(0, 8)}`}</span>
                      <span className="sidebar-thread-title">
                        {t.title || "Untitled"}
                      </span>
                    </Link>
                  ))}
                  {threadCount === 0 && (
                    <span className="sidebar-thread sidebar-thread--empty">
                      No threads
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {projects.length === 0 && (
          <div className="sidebar-empty">No projects</div>
        )}
      </nav>
    </aside>
  );
}
