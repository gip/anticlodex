import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { startAssistantRunLocal } from "./agent.js";
import { getAuthState, getValidAccessToken, login, logout, notifyRenderer, onAuthStateChanged } from "./auth.js";

let mainWindow: BrowserWindow | null = null;
let appIcon: Electron.NativeImage | null = null;
const isClaudeAgentEnabled = process.env.ACX_ENABLE_CLAUDE_AGENT === "1";

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

// Auth IPC handlers
ipcMain.handle("auth:get-state", () => getAuthState());
ipcMain.handle("auth:get-valid-token", (_event, options?: { forceRefresh?: boolean }) => getValidAccessToken(options));
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
  return startAssistantRunLocal(payload);
});

ipcMain.on("auth:login", async () => {
  const success = await login();
  if (success && mainWindow) {
    mainWindow.focus();
  }
});

ipcMain.on("auth:logout", async () => {
  await logout();
});

app.whenReady().then(() => {
  createWindow();
  onAuthStateChanged(() => {
    if (mainWindow) notifyRenderer(mainWindow);
  });
  console.info("[desktop] agent task processing enabled", { enabled: isClaudeAgentEnabled });
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
