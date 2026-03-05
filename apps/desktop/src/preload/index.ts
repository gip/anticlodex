import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  auth: {
    getState: () => ipcRenderer.invoke("auth:get-state") as Promise<{ isAuthenticated: boolean }>,
    getAccessToken: () => ipcRenderer.invoke("auth:get-token") as Promise<string | null>,
    login: () => ipcRenderer.send("auth:login"),
    logout: () => ipcRenderer.send("auth:logout"),
    onStateChanged: (callback: (state: { isAuthenticated: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: { isAuthenticated: boolean }) =>
        callback(state);
      ipcRenderer.on("auth:state-changed", handler);
      return () => ipcRenderer.removeListener("auth:state-changed", handler);
    },
  },
  assistant: {
    run: (payload: {
      handle: string;
      projectName: string;
      threadId: string;
      projectId?: string;
      runId: string;
    }) => ipcRenderer.invoke("assistant:run", payload) as Promise<unknown>,
  },
});
