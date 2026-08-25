import { app, BrowserWindow, ipcMain, nativeImage, shell, type WebContents } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { startAssistantRunLocal } from "./agent.js";
import { authKit } from "./auth.js";

let mainWindow: BrowserWindow | null = null;
let appIcon: Electron.NativeImage | null = null;
const isClaudeAgentEnabled = process.env.ACX_ENABLE_CLAUDE_AGENT === "1";
const pendingTokenRequests = new Map<
  string,
  {
    senderId: number;
    resolve: (token: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

function requestAccessToken(sender: WebContents): Promise<string> {
  if (sender.isDestroyed()) {
    return Promise.reject(new Error("Authentication window is unavailable"));
  }

  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTokenRequests.delete(requestId);
      reject(new Error("Timed out while refreshing authentication"));
    }, 15_000);

    pendingTokenRequests.set(requestId, { senderId: sender.id, resolve, reject, timeout });
    sender.send("auth:request-access-token", requestId);
  });
}

ipcMain.on(
  "auth:access-token-response",
  (event, requestId: string, result: { token?: string; error?: string }) => {
    const pending = pendingTokenRequests.get(requestId);
    if (!pending || pending.senderId !== event.sender.id) return;

    clearTimeout(pending.timeout);
    pendingTokenRequests.delete(requestId);
    if (typeof result.token === "string" && result.token.trim()) {
      pending.resolve(result.token);
      return;
    }
    pending.reject(new Error(result.error || "Not authenticated"));
  },
);

function resolveIcon(): string | null {
  const candidates = [
    join(app.getAppPath(), "assets", "icon.png"),
    join(process.resourcesPath, "assets", "icon.png"),
    join(process.resourcesPath, "app.asar.unpacked", "assets", "icon.png"),
    join(app.getAppPath(), "assets", "icon.icns"),
    join(process.resourcesPath, "assets", "icon.icns"),
  ];
  return candidates.find((candidatePath) => existsSync(candidatePath)) ?? null;
}

function loadAppIcon() {
  const iconPath = resolveIcon();
  if (!iconPath) {
    console.warn("AntiClodeX icon not found, using Electron default icon.");
    return;
  }
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.warn(`Unable to load AntiClodeX icon from ${iconPath}, using Electron default.`);
    return;
  }
  appIcon = icon;
}

function createWindow() {
  loadAppIcon();

  if (process.platform === "darwin" && app.dock && appIcon) {
    app.dock.setIcon(appIcon);
  }

  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    icon: appIcon ?? undefined,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Provider consent pages must open in the system browser: Google refuses OAuth
// inside embedded user agents, and navigating the app window away from the
// renderer leaves the user with no way back.
const INTEGRATION_AUTH_HOSTS = new Set(["accounts.google.com", "api.notion.com", "www.notion.so"]);

ipcMain.handle("integrations:open-external", async (_event, rawUrl: unknown) => {
  if (typeof rawUrl !== "string") return { error: "Invalid authorization URL" };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: "Invalid authorization URL" };
  }

  if (url.protocol !== "https:" || !INTEGRATION_AUTH_HOSTS.has(url.hostname)) {
    return { error: "Refusing to open an unexpected authorization URL" };
  }

  await shell.openExternal(url.toString());
  return { ok: true };
});

ipcMain.handle("assistant:run", async (_event, payload: {
  handle: string;
  projectName: string;
  threadId: string;
  projectId?: string;
  runId: string;
}) => {
  if (!isClaudeAgentEnabled) {
    return { error: "Desktop agent processing is disabled. Set ACX_ENABLE_CLAUDE_AGENT=1." };
  }
  return startAssistantRunLocal(payload, () => requestAccessToken(_event.sender));
});

app.whenReady().then(() => {
  authKit.registerProtocol();
  createWindow();
  console.info("[desktop] agent task processing enabled", { enabled: isClaudeAgentEnabled });
});

app.on("will-quit", () => {
  for (const pending of pendingTokenRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Application is shutting down"));
  }
  pendingTokenRequests.clear();
  authKit.cleanup();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
