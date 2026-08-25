# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (run from root)
pnpm dev:web          # Web app on http://localhost:3000
pnpm dev:api          # API server on http://localhost:3001
pnpm dev:desktop      # Electron desktop app

# Build
pnpm build:web        # TypeScript check + Vite build
pnpm build:desktop    # electron-vite build

# API
pnpm --filter api build    # tsc
pnpm --filter api start    # node dist/index.js

# Database
pnpm migrate          # Reset schema (drops all tables, re-runs migrations)
```

## Architecture

pnpm workspaces monorepo with four packages:

- **apps/web** — React 19 SPA with WorkOS AuthKit, Vite, port 3000
- **apps/desktop** — Electron + React 19 via `electron-vite`, with WorkOS AuthKit PKCE and encrypted token storage
- **apps/api** — Fastify 5, raw SQL via `pg` (no ORM), WorkOS JWT verification via `jose`, port 3001
- **packages/ui** — Shared React components (Header, Home, ThemeProvider, AuthContext). Exports raw TSX with no build step — consumed directly by Vite

### Auth Flow
- **Web:** AuthKit hosted flow → WorkOS access token → bearer token sent to API
- **Desktop:** AuthKit Electron system-browser PKCE flow → `anticlodex://auth/callback` → encrypted main-process session
- **API:** `verifyAuth` verifies bearer tokens against the WorkOS client JWKS and attaches the local user to `req.auth`

### Database
- PostgreSQL, connected via `pg.Pool` in `apps/api/src/db.ts`
- Single init script: `apps/api/db/migrations/0001_init_full_schema.sql` — `pnpm migrate` drops everything and recreates (dev-only)
- User upsert on `identity_subject` conflict in `apps/api/src/auth.ts`

### OpenShip Domain Model
See [docs/openship-schema.md](docs/openship-schema.md) for the full schema reference — systems, nodes, edges, concerns, documents, the concern matrix, projects, threads, actions, and content-addressed file storage.

### Electron-specific
- Preload must output CJS (`lib.formats: ["cjs"]`) in `electron.vite.config.ts`
- Renderer `root` must be explicitly `src/renderer`
- Main process env vars use `envPrefix: "VITE_"` + `import.meta.env.VITE_*`
- Authentication IPC is owned by `@workos/authkit-electron`

## Code Conventions

- ESM everywhere (except Electron preload which must be CJS)
- TypeScript strict mode, target ES2022
- No ORM — raw SQL with parameterized queries
- Minimalist UI style (Vercel-inspired), CSS variables for light/dark theming
- WorkOS setup and Auth0 migration are documented in `docs/auth-workos.md`
- Environment variables: copy `.env.example` → `.env.local` in each app
