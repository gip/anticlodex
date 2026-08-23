import { useEffect, useState } from "react";
import { Moon, Sun, PanelLeft } from "lucide-react";
import { useAuth } from "./auth-context";
import { useTheme } from "./theme";

export function StatusBar({
  variant = "web",
  onToggleSidebar,
  contextLabel,
}: {
  variant?: "web" | "desktop";
  onToggleSidebar?: () => void;
  contextLabel?: string;
}) {
  const { isAuthenticated } = useAuth();
  const { theme, toggle } = useTheme();
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const isDesktop = variant === "desktop";

  return (
    <footer className={`status-bar${isDesktop ? " status-bar--desktop" : ""}`}>
      <div className="status-bar-left">
        {isAuthenticated && onToggleSidebar && (
          <button
            type="button"
            className="status-bar-btn"
            onClick={onToggleSidebar}
            aria-label="Toggle sidebar"
          >
            <PanelLeft size={14} />
          </button>
        )}
        {contextLabel && (
          <span className="status-bar-context" title={contextLabel}>
            {contextLabel}
          </span>
        )}
      </div>
      <div className="status-bar-center">
        Built by{" "}
        <a
          href="https://x.com/wutheringsf"
          target="_blank"
          rel="noreferrer"
          className="status-bar-credit"
        >
          @wutheringsf
        </a>
      </div>
      <div className="status-bar-right">
        <span
          className={`status-bar-dot${online ? " status-bar-dot--online" : " status-bar-dot--offline"}`}
          aria-label={online ? "Online" : "Offline"}
          title={online ? "Online" : "Offline"}
        />
        <button
          type="button"
          className="status-bar-btn"
          onClick={toggle}
          aria-label="Toggle theme"
        >
          {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
        </button>
      </div>
    </footer>
  );
}
