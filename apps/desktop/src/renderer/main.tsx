import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { AuthKitProvider } from "@workos/authkit-electron/react";
import { ThemeProvider, SchemeProvider } from "@acx/ui";
import "@acx/ui/styles.css";
import { App } from "./app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthKitProvider>
      <SchemeProvider>
        <ThemeProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ThemeProvider>
      </SchemeProvider>
    </AuthKitProvider>
  </StrictMode>,
);
