# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## Commands

```bash
# Development (run from repo root)
pnpm dev:web               # Web app on http://localhost:3000
pnpm dev:api               # API server on http://localhost:3001
pnpm dev:desktop           # Electron desktop app
pnpm dev:desktop:with-api  # Desktop + API together with ACX agent runner enabled

# Build
pnpm build:web             # Web TypeScript check + Vite build
pnpm build:api             # API TypeScript build
pnpm build:desktop         # electron-vite build

# Package-scoped commands
pnpm --filter @acx/api build
pnpm --filter @acx/api start
pnpm --filter @acx/api test
pnpm --filter @acx/web build
pnpm --filter @acx/desktop build

# Database
pnpm migrate               # Runs the API migration command
pnpm --filter @acx/api migrate:status
pnpm --filter @acx/api migrate:down:last
```

## Architecture

pnpm workspace monorepo with these app/package directories:

- **apps/web** — React 19 SPA, Vite, Auth0 web login, port 3000
- **apps/desktop** — Electron 40 + React 19 via `electron-vite`
- **apps/api** — Fastify 5 API, PostgreSQL via `pg`, Auth0 JWT verification via `jose`
- **packages/ui** — Shared React components consumed directly by the web and desktop apps
- **packages/agent-runtime** — Shared agent/runtime types and helpers used by API and desktop

### API Shape

- The API is mounted under the `/v1` prefix. Client URLs normalize to `/v1` automatically in the desktop app, and API helpers in the web app expect v1 routes.
- `verifyAuth` protects authenticated routes and `verifyOptionalAuth` is used on public read routes that can render different data for signed-in vs signed-out viewers.
- Anonymous `GET` caching is implemented at the Fastify layer and is opt-in per route via `config.anonymousCache`.
- Anonymous cache storage uses Redis when `REDIS_URL` is set. It is guest-only, stores only `200 application/json` responses, uses a short TTL, and fails open if Redis is unavailable.

### Auth Flow

- **Web:** Auth0 React SDK, `cacheLocation="localstorage"`, refresh tokens enabled, bearer token sent to the API
- **Desktop:** Auth0 PKCE flow with a local callback server on `127.0.0.1:17823`, then token sync through the API `/me` endpoint under `/v1`
- **API:** Bearer token verification against Auth0 JWKS, then user lookup/create in PostgreSQL with `req.auth` attached on success

### Database

- PostgreSQL connection lives in `apps/api/src/db.ts` via `pg.Pool`
- The current migration entrypoint is `apps/api/db/migrations/001_init_full_schema.sql`
- `pnpm migrate` delegates to the API package migration command; do not assume it is a safe reset wrapper unless you inspect the current migration scripts
- User creation/upsert is handled in `apps/api/src/auth.ts`

### Electron-specific

- Preload must output CommonJS via `lib.formats: ["cjs"]` in `apps/desktop/electron.vite.config.ts`
- Renderer root must remain `src/renderer`
- Main process env exposure uses `envPrefix: "VITE_"`
- Auth IPC channels are `auth:get-state`, `auth:login`, `auth:logout`, `auth:state-changed`

## Code Conventions

- ESM everywhere except the Electron preload bundle, which must stay CJS
- TypeScript strict mode, target ES2022
- No ORM; use raw parameterized SQL
- Shared UI lives in `packages/ui` and is imported directly rather than built separately
- Auth0 tenant/domain is `edfi.us.auth0.com`
- Environment variables are copied from each app's `.env.example` to `.env.local`

## Environment Notes

- API defaults to `http://localhost:3001` and is registered under `/v1`
- Web and desktop clients both expect Auth0 env vars plus an API URL
- API Redis cache env vars:
  - `REDIS_URL` enables anonymous response caching
  - `REDIS_PREFIX` overrides the Redis key prefix
  - `REDIS_CACHE_TTL_SECONDS` overrides the default 60-second TTL
