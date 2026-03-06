# AntiClodeX Public API (v1) - Overview

## Status and operating mode

AntiClodeX ships a v1 public API only in this phase.

- There are **no backward-compatibility guarantees** with legacy routes.
- The entire initial database schema is created from a single migration:
  - `apps/api/db/migrations/0001_init_full_schema.sql`
- Existing non-empty production DB migration paths are out of scope for this phase.
- Migrations are managed by `node-pg-migrate`.

## Base URL and auth

- Base URL: `https://{host}/v1`
- Auth: Bearer token only
- Tenant scope comes from Auth0 claims:
  - `sub` (subject)
  - `orgId`
  - `scope`

All responses use:
- IDs: UUID for `id`, path params, and body references
- Timestamps: RFC3339 UTC strings

## Error model

Errors use `application/problem+json`:

```json
{
  "type": "https://tools.ietf.org/html/rfc7807#section-3.1",
  "title": "Invalid project name",
  "status": 400,
  "detail": "name must contain only safe characters.",
  "instance": "/v1/threads/...."
}
```

## Pagination

List endpoints return:
- `items`: array of rows
- `page`: current 1-based page
- `pageSize`: requested or default page size
- `nextCursor`: nullable cursor or next page token

Query helpers:

- `page` and `pageSize` for `/projects`, `/threads`
- `limit` for `/events`

## Endpoint map

- `POST /v1/threads`
- `GET /v1/threads`
- `GET /v1/threads/:threadId`
- `PATCH /v1/threads/:threadId`
- `DELETE /v1/threads/:threadId`

- `GET /v1/threads/:threadId/matrix`
- `PATCH /v1/threads/:threadId/matrix`

- `POST /v1/threads/:threadId/chat`
- `POST /v1/threads/:threadId/assistants/{assistantType}/runs`
- `GET /v1/assistant-runs/:runId`
- `POST /v1/assistant-runs/:runId/claim`
- `POST /v1/assistant-runs/:runId/complete`
- `POST /v1/assistant-runs/:runId/cancel`

- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/projects/check-name`
- `GET /v1/projects/:handle/:projectName/collaborators`
- `PATCH /v1/projects/:handle/:projectName/description`
- `PATCH /v1/projects/:handle/:projectName/visibility`
- `POST /v1/projects/:handle/:projectName/archive`
- `POST /v1/projects/:handle/:projectName/collaborators`
- `DELETE /v1/projects/:handle/:projectName/collaborators/:collaboratorHandle`
- `PUT /v1/projects/:handle/:projectName/collaborators/:collaboratorHandle/roles`
- `POST /v1/projects/:handle/:projectName/roles`
- `DELETE /v1/projects/:handle/:projectName/roles/:roleName`
- `POST /v1/projects/:handle/:projectName/concerns`
- `DELETE /v1/projects/:handle/:projectName/concerns/:concernName`

- `GET /v1/integrations`  
- `GET /v1/integrations/:provider/authorize-url`
- `GET /v1/integrations/:provider/callback`
- `GET /v1/integrations/:provider/status`

- `GET /v1/events?since=<cursor|timestamp>&limit=<n>`
- `GET /v1/events/stream?since=<cursor|timestamp>`

## Event model

## OAuth callback URLs

- Provider redirect URIs must target the API base URL, not the SPA origin.
- Canonical callbacks:
  - `/v1/integrations/notion/callback`
  - `/v1/integrations/google/callback`
- If the API is accessed through a public origin that differs from the inbound request host, set `INTEGRATION_OAUTH_CALLBACK_ORIGIN` so OAuth providers receive the externally registered API origin.

Shared event payload:

- `id`: event ID used for cursoring
- `type`: one of
  - `chat.session.finished`
  - `assistant.run.started`
  - `assistant.run.progress`
  - `assistant.run.waiting_input`
  - `assistant.run.completed`
  - `assistant.run.failed`
  - `assistant.run.cancelled`
  - `thread.matrix.changed`
- `aggregateType`
- `aggregateId`
- `occurredAt`
- `traceId`
- `payload`
- `version`

## Event delivery recommendation

- Prefer SSE during active UI sessions: `/events/stream`
- Use cursor-based polling fallback: `/events`
- Both channels return the same event ordering.
- SSE supports `Last-Event-ID` replay.

## Run flow examples

### Start a run

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
-d '{"prompt":"summarize latest changes"}' \
  "https://localhost:3001/v1/threads/$THREAD_ID/assistants/direct/runs"
```

### Poll the run

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://localhost:3001/v1/assistant-runs/$RUN_ID"
```

### Poll events

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://localhost:3001/v1/events?since=$CURSOR_OR_TIMESTAMP&limit=100"
```

### Stream events

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  "https://localhost:3001/v1/events/stream?since=$CURSOR_OR_TIMESTAMP"
```

## Migration policy

- Single initial migration only:
  - `apps/api/db/migrations/0001_init_full_schema.sql`
- Bootstrap flow:
  1. Create empty DB
  2. Run schema migration
  3. Seed reference data if needed
- This phase intentionally has no backward compatibility with prior API versions.

## Migration execution

- Run migration:
  - `pnpm --filter @acx/api migrate`
- Check migration status:
  - `pnpm --filter @acx/api migrate:status`
- Roll back last migration (dev-only fallback):
  - `pnpm --filter @acx/api migrate:down:last`
