import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthKitProvider } from "@workos-inc/authkit-react";
import { ThemeProvider, SchemeProvider } from "@acx/ui";
import "@acx/ui/styles.css";
import { App } from "./app";

const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID ?? "";
const apiHostname = import.meta.env.VITE_WORKOS_API_HOSTNAME?.trim() || undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthKitProvider
      clientId={clientId}
      apiHostname={apiHostname}
    >
      <SchemeProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </SchemeProvider>
    </AuthKitProvider>
  </StrictMode>,
);
