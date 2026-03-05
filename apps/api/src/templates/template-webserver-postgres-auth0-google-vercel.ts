import type { TemplateDefinition } from "./index.js";

export const templateWebserverPostgresAuth0GoogleVercel: TemplateDefinition = {
  id: "webserver-postgres-auth0-google-vercel",
  label: "Webserver + Postgres + Auth0 Google login + Vercel",
  description: "Browser + React frontend, webserver, Postgres, Auth0+Google, and Vercel hosting.",
  nodes: [
    {
      key: "browser_host",
      name: "Browser",
      kind: "Host",
      metadata: {
        ownership: "third_party",
        boundary: "external",
      },
      parentKey: "root",
      layout: {
        x: 0,
        y: 0,
      },
    },
    {
      key: "react_frontend",
      name: "Frontend (React)",
      kind: "Process",
      metadata: {
        ownership: "first_party",
        boundary: "external",
      },
      parentKey: "browser_host",
      layout: {
        x: 80,
        y: -10,
      },
    },
    {
      key: "vercel_host",
      name: "Vercel",
      kind: "Host",
      metadata: {
        ownership: "third_party",
        boundary: "external",
      },
      parentKey: "root",
      layout: {
        x: 300,
        y: -100,
      },
    },
    {
      key: "webserver_process",
      name: "Backend (Vercel)",
      kind: "Process",
      metadata: {
        ownership: "first_party",
        boundary: "external",
      },
      parentKey: "vercel_host",
      layout: {
        x: 380,
        y: -110,
      },
    },
    {
      key: "postgres_host",
      name: "Postgres Runtime",
      kind: "Host",
      metadata: {
        ownership: "first_party",
        boundary: "internal",
      },
      parentKey: "root",
      layout: {
        x: 620,
        y: 240,
      },
    },
    {
      key: "postgres_process",
      name: "Postgres",
      kind: "Process",
      metadata: {
        ownership: "first_party",
        boundary: "internal",
      },
      parentKey: "postgres_host",
      layout: {
        x: 700,
        y: 250,
      },
    },
    {
      key: "auth0_host",
      name: "Auth0",
      kind: "Host",
      metadata: {
        ownership: "third_party",
        boundary: "external",
      },
      parentKey: "root",
      layout: {
        x: 620,
        y: 0,
      },
    },
    {
      key: "auth0_process",
      name: "Auth0 Service",
      kind: "Process",
      metadata: {
        ownership: "third_party",
        boundary: "external",
      },
      parentKey: "auth0_host",
      layout: {
        x: 700,
        y: -10,
      },
    },
    {
      key: "google_host",
      name: "Google Identity",
      kind: "Host",
      metadata: {
        ownership: "third_party",
        boundary: "external",
      },
      parentKey: "root",
      layout: {
        x: 900,
        y: 0,
      },
    },
    {
      key: "google_oauth_process",
      name: "Google OAuth",
      kind: "Process",
      metadata: {
        ownership: "third_party",
        boundary: "external",
      },
      parentKey: "google_host",
      layout: {
        x: 980,
        y: -10,
      },
    },
  ],
  edges: [
    {
      fromKey: "react_frontend",
      toKey: "webserver_process",
      type: "Runtime",
      protocol: "HTTPS",
    },
    {
      fromKey: "webserver_process",
      toKey: "postgres_process",
      type: "Dataflow",
      protocol: "PG Wire",
    },
    {
      fromKey: "webserver_process",
      toKey: "auth0_process",
      type: "Runtime",
      protocol: "HTTPS",
    },
    {
      fromKey: "react_frontend",
      toKey: "auth0_process",
      type: "Runtime",
      protocol: "HTTPS",
    },
    {
      fromKey: "auth0_process",
      toKey: "google_oauth_process",
      type: "Runtime",
      protocol: "HTTPS",
    },
  ],
  concerns: [
    {
      name: "Features",
      position: 1,
      isBaseline: false,
    },
    {
      name: "Interfaces",
      position: 2,
      isBaseline: false,
    },
    {
      name: "Connectivity",
      position: 3,
      isBaseline: false,
    },
    {
      name: "Security",
      position: 4,
      isBaseline: false,
    },
    {
      name: "Data Model",
      position: 5,
      isBaseline: false,
    },
    {
      name: "General Specs",
      position: 6,
      isBaseline: false,
    },
    {
      name: "General Skills",
      position: 7,
      isBaseline: false,
    },
    {
      name: "Implementation",
      position: 8,
      isBaseline: false,
    },
    {
      name: "Deployment",
      position: 9,
      isBaseline: false,
    },
    {
      name: "Functional Testing",
      position: 10,
      isBaseline: false,
    },
  ],
  documents: [
    {
      key: "spec_stack_overview",
      kind: "Document",
      title: "Stack overview",
      language: "en",
      text:
        "The system is composed of host-wrapped runtime components: Browser/Frontend (React), Vercel/Backend (Vercel), Postgres Runtime/Postgres, Auth0/Auth0 Service, and Google Identity/Google OAuth.",
    },
    {
      key: "spec_browser_host",
      kind: "Document",
      title: "Browser host",
      language: "en",
      text:
        "The browser host runs the React application process and acts as the user-facing execution environment for interactive UI behavior.",
    },
    {
      key: "spec_react_frontend",
      kind: "Document",
      title: "React frontend process",
      language: "en",
      text:
        "The React process renders application UI, calls the backend over HTTPS, and drives login initiation through Auth0.",
    },
    {
      key: "spec_vercel_host",
      kind: "Document",
      title: "Vercel host",
      language: "en",
      text:
        "Vercel is a third-party host that runs the first-party backend process and provides deployment lifecycle controls, public HTTPS ingress, and runtime isolation.",
    },
    {
      key: "spec_webserver_process",
      kind: "Document",
      title: "Backend process",
      language: "en",
      text:
        "The first-party backend process serves APIs consumed by the frontend over HTTPS and reads/writes persistent records in Postgres over PG Wire.",
    },
    {
      key: "spec_postgres_host",
      kind: "Document",
      title: "Postgres host",
      language: "en",
      text:
        "Postgres Runtime encapsulates database runtime concerns including process isolation, network exposure, and operational configuration for persistence.",
    },
    {
      key: "spec_postgres_process",
      kind: "Document",
      title: "Postgres process",
      language: "en",
      text:
        "The Postgres process stores transactional data and accepts backend connections over PG Wire with credentialed access.",
    },
    {
      key: "spec_auth0_host",
      kind: "Document",
      title: "Auth0 identity host",
      language: "en",
      text:
        "Auth0 provides the managed identity boundary that encapsulates OAuth/OIDC flows and token management capabilities.",
    },
    {
      key: "spec_auth0_process",
      kind: "Document",
      title: "Auth0 service process",
      language: "en",
      text:
        "The Auth0 service process executes login flows, issues tokens, and federates outbound authentication requests to Google OAuth.",
    },
    {
      key: "spec_google_host",
      kind: "Document",
      title: "Google identity host",
      language: "en",
      text:
        "Google Identity is an external identity boundary that hosts the Google OAuth service used by Auth0 social login federation.",
    },
    {
      key: "spec_google_oauth_process",
      kind: "Document",
      title: "Google OAuth process",
      language: "en",
      text:
        "Google OAuth authenticates end users and returns identity assertions to Auth0 over HTTPS for federated sign-in.",
    },
  ],
  matrixRefs: [
    {
      nodeKey: "root",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_stack_overview",
    },
    {
      nodeKey: "browser_host",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_browser_host",
    },
    {
      nodeKey: "react_frontend",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_react_frontend",
    },
    {
      nodeKey: "vercel_host",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_vercel_host",
    },
    {
      nodeKey: "webserver_process",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_webserver_process",
    },
    {
      nodeKey: "postgres_host",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_postgres_host",
    },
    {
      nodeKey: "postgres_process",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_postgres_process",
    },
    {
      nodeKey: "auth0_host",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_auth0_host",
    },
    {
      nodeKey: "auth0_process",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_auth0_process",
    },
    {
      nodeKey: "google_host",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_google_host",
    },
    {
      nodeKey: "google_oauth_process",
      concern: "General Specs",
      refType: "Document",
      documentKey: "spec_google_oauth_process",
    },
  ],
};
