import { app, BrowserWindow } from "electron";
import { createAuthKit } from "@workos/authkit-electron";

// Must run before createAuthKit() below: it builds the session store eagerly,
// which pins `app.getPath("userData")`, and safeStorage names its macOS
// keychain item after the app. Without this Electron falls back to
// package.json `name`, so users see "@acx/desktop wants to use your
// confidential information" and data lands in ~/Library/Application Support/@acx.
app.setName("Anticlodex");

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
