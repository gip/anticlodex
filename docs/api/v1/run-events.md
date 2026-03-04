# Event delivery (poll + SSE)

AntiClodeX exposes every run/session change through two channels:

- `GET /v1/events` for cursor-based polling
- `GET /v1/events/stream` for streaming (SSE)

Both channels emit the same event stream in strict order.

## Event model

```ts
interface ACXEvent {
  id: string;                // cursor-safe event id
  type: "chat.session.finished" | "assistant.run.started" | "assistant.run.progress" | "assistant.run.waiting_input" | "assistant.run.completed" | "assistant.run.failed" | "assistant.run.cancelled" | "thread.matrix.changed";
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  traceId: string;
  payload: Record<string, unknown>;
  version: number;
}
```

## Polling contract

- Endpoint: `GET /v1/events`
- Query:
  - `since`: optional cursor or RFC3339 timestamp
  - `limit`: optional 1..500 (`100` default)
- Response:

```json
{
  "items": [
    {
      "id": "018fa9...",
      "type": "assistant.run.started",
      "aggregateType": "assistant-run",
      "aggregateId": "018f...",
      "occurredAt": "2026-02-18T10:15:00.000Z",
      "traceId": "018f...",
      "payload": { "threadId": "018fa9..." },
      "version": 1
    }
  ],
  "nextCursor": "2026-02-18T10:15:00.000Z%7C018fa9...",
  "page": 1,
  "pageSize": 100
}
```

Use `nextCursor` as the next `since` value. The cursor is page-safe and deterministic.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://localhost:3001/v1/events?since=$CURSOR_OR_TIMESTAMP&limit=100"
```

## SSE contract

- Endpoint: `GET /v1/events/stream`
- Query:
  - `since`: optional cursor or RFC3339 timestamp
- Optional `Last-Event-ID` header for resume
- Stream semantics:
  - SSE format
  - `retry: 3000` heartbeat cadence sent from server
  - heartbeat comments: `: heartbeat`
- Event metadata:
  - `id`: cursor for that event
  - `event`: event type
  - `data`: serialized JSON event object

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  "https://localhost:3001/v1/events/stream?since=$CURSOR_OR_TIMESTAMP"
```

### Browser `EventSource` (recommended where header transport is available)

```js
let lastCursor = null;
const cursor = encodeURIComponent(lastCursor ?? "");
const source = new EventSource(`https://localhost:3001/v1/events/stream?since=${cursor}`);

source.addEventListener("message", (evt) => {
  const event = JSON.parse(evt.data);
  lastCursor = evt.lastEventId || lastCursor;
  // apply event.payload changes
});

source.addEventListener("error", () => {
  source.close();
  // switch to GET /v1/events?since=<lastCursor> poll recovery
});
```

> If your EventSource transport cannot send bearer credentials, use a server-side session auth model for SSE or use `/v1/events` polling instead.

### Resume flow

1. Keep the last received event id: `lastEventId = event.id`
2. On reconnect, pass `Last-Event-ID: $lastEventId`
3. If the stream cannot be resumed from the gateway buffer, fallback:
   - call `GET /v1/events?since=$lastEventId` (or last known `occurredAt` string) once, then reconnect again

## Client strategy

Recommended:
- Use SSE while connected in active UIs.
- Fall back to polling when SSE is unavailable, blocked, or repeatedly disconnecting.
- Polling fallback period should be moderate (`5s` default) and use `nextCursor`.
