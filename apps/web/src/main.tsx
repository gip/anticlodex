import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Auth0Provider } from "@auth0/auth0-react";
import { ThemeProvider } from "@acx/ui";
import "@acx/ui/styles.css";
import { App } from "./app";

const domain = import.meta.env.VITE_AUTH0_DOMAIN ?? "";
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID ?? "";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      cacheLocation="localstorage"
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
      }}
    >
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </Auth0Provider>
  </StrictMode>,
);
