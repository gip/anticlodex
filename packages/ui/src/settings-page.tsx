import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "./link";
import { useScheme, SCHEMES } from "./scheme";
import type { IntegrationConnectionStatus, IntegrationProvider, IntegrationStatusRecord } from "./thread-page";

type MutationError = { error: string };
type MutationResult<T> = T | MutationError | void;

export interface SettingsPageProps {
  returnTo?: string;
  integrationStatuses?: IntegrationStatusRecord;
  onConnectIntegration: (provider: IntegrationProvider, returnTo: string) => Promise<MutationResult<{ status: IntegrationConnectionStatus }>>;
  onDisconnectIntegration: (provider: IntegrationProvider) => Promise<MutationResult<{ status: IntegrationConnectionStatus }>>;
}

const INTEGRATION_LABELS: Record<IntegrationProvider, string> = {
  notion: "Notion",
  google: "Google Docs",
};

const INTEGRATION_PROVIDERS = ["notion", "google"] as const;

function getStatusLabel(status?: IntegrationConnectionStatus) {
  if (!status) return "Disconnected";
  if (status === "connected") return "Connected";
  return `Disconnected (${status})`;
}

const getErrorMessage = (result: MutationResult<{ status: IntegrationConnectionStatus }>) => {
  if (!result || typeof result !== "object") return null;
  const hasError = "error" in result && result !== null;
  const rawError = hasError ? (result as MutationError).error : null;
  return typeof rawError === "string" ? rawError : null;
};

function IntegrationRow({
  provider,
  status,
  isBusy,
  onConnect,
  onDisconnect,
}: {
  provider: IntegrationProvider;
  status: IntegrationConnectionStatus;
  isBusy: boolean;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const isConnected = status === "connected";
  return (
    <div className="profile-integration-row">
      <div>
        <div className="profile-integration-name">{INTEGRATION_LABELS[provider]}</div>
        <div className="profile-integration-status">{getStatusLabel(status)}</div>
      </div>
      <button
        className="btn btn-secondary profile-integration-action"
        type="button"
        onClick={isConnected ? onDisconnect : onConnect}
        disabled={isBusy}
      >
        {isBusy ? (isConnected ? "Disconnecting..." : "Connecting...") : isConnected ? "Disconnect" : "Connect"}
      </button>
    </div>
  );
}

export function SettingsPage({
  returnTo = "/settings",
  integrationStatuses = { notion: "disconnected", google: "disconnected" },
  onConnectIntegration,
  onDisconnectIntegration,
}: SettingsPageProps) {
  const [activeProvider, setActiveProvider] = useState<IntegrationProvider | null>(null);
  const [integrationError, setIntegrationError] = useState("");
  const { scheme, setScheme } = useScheme();

  const handleConnect = async (provider: IntegrationProvider) => {
    setIntegrationError("");
    setActiveProvider(provider);
    const result = await onConnectIntegration(provider, returnTo);
    setActiveProvider(null);
    const error = getErrorMessage(result);
    if (error) {
      setIntegrationError(error);
    }
  };

  const handleDisconnect = async (provider: IntegrationProvider) => {
    setIntegrationError("");
    setActiveProvider(provider);
    const result = await onDisconnectIntegration(provider);
    setActiveProvider(null);
    const error = getErrorMessage(result);
    if (error) {
      setIntegrationError(error);
    }
  };

  return (
    <div className="page settings-page">
      <div className="page-header">
        <Link to="/" className="page-back">
          <ArrowLeft size={20} />
        </Link>
        <h1 className="page-title">Settings</h1>
      </div>

      <section className="thread-section">
        <h2 className="thread-section-title">Color scheme</h2>
        <p className="page-description">
          Choose how the interface looks. The layout and font stay the same — only the colors change.
        </p>
        <div className="scheme-picker">
          {SCHEMES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`scheme-option${scheme === s.id ? " scheme-option--active" : ""}`}
              onClick={() => setScheme(s.id)}
            >
              <span className={`scheme-swatch scheme-swatch--${s.id}`} aria-hidden />
              <span className="scheme-option-text">
                <span className="scheme-option-label">{s.label}</span>
                <span className="scheme-option-description">{s.description}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="thread-section profile-integrations">
        <h2 className="thread-section-title">Document integrations</h2>
        <p className="page-description">
          Connect Notion and Google Docs here so you can import remote documents from those sources.
        </p>
        <div className="profile-integration-list">
          {INTEGRATION_PROVIDERS.map((provider) => (
            <IntegrationRow
              key={provider}
              provider={provider}
              status={integrationStatuses[provider]}
              isBusy={activeProvider === provider}
              onConnect={() => handleConnect(provider)}
              onDisconnect={() => handleDisconnect(provider)}
            />
          ))}
        </div>
        {integrationError ? <p className="field-error">{integrationError}</p> : null}
      </section>
    </div>
  );
}
