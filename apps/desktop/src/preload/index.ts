import { contextBridge, ipcRenderer } from "electron";
import { exposeAuthKit } from "@workos/authkit-electron/preload";

exposeAuthKit();

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  auth: {
    onAccessTokenRequested: (callback: (requestId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, requestId: string) =>
        callback(requestId);
      ipcRenderer.on("auth:request-access-token", listener);
      return () => ipcRenderer.removeListener("auth:request-access-token", listener);
    },
    respondWithAccessToken: (
      requestId: string,
      result: { token?: string; error?: string },
    ) => ipcRenderer.send("auth:access-token-response", requestId, result),
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
