import { useState, useRef, useEffect } from "react";
import { Moon, Sun, PanelLeft } from "lucide-react";
import { useAuth } from "./auth-context";
import { useTheme } from "./theme";
import { Link } from "./link";
import { Logo } from "./logo";

export function Header({
  variant = "web",
  projectLabel,
  projectHref,
  onToggleSidebar,
}: {
  variant?: "web" | "desktop";
  projectLabel?: string;
  projectHref?: string;
  onToggleSidebar?: () => void;
}) {
  const { isAuthenticated, isLoading, user, login, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  const isDesktop = variant === "desktop";

  return (
    <header className={`header${isDesktop ? " header--desktop" : ""}`}>
      <div className="header-left">
        {isDesktop && onToggleSidebar && isAuthenticated && (
          <button className="btn-icon btn-icon-theme header-no-drag" onClick={onToggleSidebar} aria-label="Toggle sidebar">
            <PanelLeft size={14} />
          </button>
        )}
        {!isDesktop && (
          <>
            <Link to="/" className="header-logo">
              <Logo />
              AntiClodeX
            </Link>
            {onToggleSidebar && isAuthenticated && (
              <button className="btn-icon btn-icon-theme header-sidebar-toggle-web" onClick={onToggleSidebar} aria-label="Toggle sidebar">
                <PanelLeft size={14} />
              </button>
            )}
          </>
        )}
        {isDesktop && projectLabel && (
          <Link to={projectHref ?? "/"} className="header-project-label header-no-drag">
            {projectLabel}
          </Link>
        )}
      </div>
      {isDesktop && (
        <div className="header-center">
          <Link to="/" className="header-logo header-no-drag">
            <Logo />
            AntiClodeX
          </Link>
        </div>
      )}
      <div className="header-right">
        <button className="btn-icon btn-icon-theme header-no-drag" onClick={toggle} aria-label="Toggle theme">
          {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        {isLoading ? null : !isAuthenticated ? (
          <button className="btn header-no-drag" onClick={login}>Log In</button>
        ) : (
          <div className="avatar-menu header-no-drag" ref={menuRef}>
            <button className="avatar-btn header-no-drag" onClick={() => setMenuOpen((v) => !v)}>
              {user?.picture ? (
                <img className="avatar-img" src={user.picture} alt="" />
              ) : (
                <span className="avatar-fallback">
                  {(user?.handle ?? "?")[0].toUpperCase()}
                </span>
              )}
            </button>
            {menuOpen && (
              <div className="dropdown header-no-drag">
                <div className="dropdown-user">
                  <span className="dropdown-handle">{user?.handle}</span>
                  {user?.email && <span className="dropdown-email">{user.email}</span>}
                </div>
                <div className="dropdown-divider" />
                <Link to="/" className="dropdown-item header-no-drag" onClick={() => setMenuOpen(false)}>
                  Home Page
                </Link>
                {user?.handle && (
                  <Link to={`/${user.handle}`} className="dropdown-item header-no-drag" onClick={() => setMenuOpen(false)}>
                    Profile
                  </Link>
                )}
                <Link to="/settings" className="dropdown-item header-no-drag" onClick={() => setMenuOpen(false)}>
                  Settings
                </Link>
                <button className="dropdown-item header-no-drag" onClick={() => { setMenuOpen(false); logout(); }}>
                  Log Out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
