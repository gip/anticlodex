import { BrowserWindow } from "electron";
import { createAuthKit } from "@workos/authkit-electron";

const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID ?? "";
const redirectUri =
  import.meta.env.VITE_WORKOS_REDIRECT_URI?.trim() || "anticlodex://auth/callback";

export const authKit = createAuthKit(
  {
    clientId,
    redirectUri,
  },
  {
    onSecondInstance: () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    },
  },
);
