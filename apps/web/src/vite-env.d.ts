/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WORKOS_CLIENT_ID: string;
  readonly VITE_WORKOS_API_HOSTNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
