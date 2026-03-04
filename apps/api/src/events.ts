import { randomUUID } from "node:crypto";
import { query } from "./db.js";

export const ACX_EVENT_TYPES = [
  "chat.session.finished",
  "assistant.run.started",
  "assistant.run.progress",
  "assistant.run.waiting_input",
  "assistant.run.completed",
  "assistant.run.failed",
  "assistant.run.cancelled",
  "thread.matrix.changed",
] as const;

export type ACXEventType = (typeof ACX_EVENT_TYPES)[number];

export interface ACXEvent { 
  id: string;
  type: ACXEventType;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  orgId: string | null;
  traceId: string | null;
  payload: Record<string, unknown>;
  version: number;
}

interface ACXEventRow {
  id: string;
  type: ACXEventType;
  aggregate_type: string;
  aggregate_id: string;
  org_id: string | null;
  occurred_at: string | Date;
  trace_id: string | null;
  payload: Record<string, unknown>;
  version: number;
}

export interface PublishEventInput {
  type: ACXEventType;
  aggregateType: string;
  aggregateId: string;
  orgId?: string | null;
  payload: Record<string, unknown>;
  traceId?: string | null;
  version?: number;
  occurredAt?: Date;
}

export interface EventQuery {
  aggregateType?: string;
  aggregateId?: string;
  orgId?: string | null;
  since?: string;
  limit?: number;
}

function normalizeOccurredAt(row: ACXEventRow): ACXEvent {
  const occurredAt = row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at);

  return {
    id: row.id,
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    occurredAt: occurredAt.toISOString(),
    orgId: row.org_id,
    traceId: row.trace_id,
    payload: row.payload,
    version: row.version,
  };
}

export function encodeCursor(event: ACXEvent): string {
  return `${encodeURIComponent(event.occurredAt)}|${encodeURIComponent(event.id)}`;
}

export function parseCursor(cursor: string): { occurredAt: string; id: string } | null {
  const parts = cursor.split("|");
  if (parts.length !== 2) return null;

  const occurredAt = decodeURIComponent(parts[0] ?? "");
  const id = decodeURIComponent(parts[1] ?? "");
  if (!occurredAt || !id) return null;

  const occurredDate = new Date(occurredAt);
  if (Number.isNaN(occurredDate.getTime())) return null;

  return { occurredAt: occurredDate.toISOString(), id };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function publishEvent(input: PublishEventInput): Promise<ACXEvent> {
  const row = await query<ACXEventRow>(
    `INSERT INTO acx_events (
       id, aggregate_type, aggregate_id, org_id, type, trace_id, payload, version, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, type, aggregate_type, aggregate_id, org_id, occurred_at, trace_id, payload, version`,
    [
      randomUUID(),
      input.aggregateType,
      input.aggregateId,
      input.orgId ?? null,
      input.type,
      input.traceId ?? null,
      isJsonObject(input.payload) ? input.payload : { value: input.payload },
      input.version ?? 1,
      input.occurredAt ?? new Date(),
    ],
  );

  if (row.rowCount === 0) {
    throw new Error("Unable to persist event");
  }

  return normalizeOccurredAt(row.rows[0]!);
}

function parseLimit(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 100;
  return Math.min(Math.max(Math.floor(raw), 1), 500);
}

export async function queryEvents(input: EventQuery): Promise<{ items: ACXEvent[]; nextCursor: string | null }> {
  const limit = parseLimit(input.limit);

  let whereClause = "1 = 1";
  const params: Array<unknown> = [];

  if (input.aggregateType) {
    params.push(input.aggregateType);
    whereClause += ` AND aggregate_type = $${params.length}`;
  }

  if (input.aggregateId) {
    params.push(input.aggregateId);
    whereClause += ` AND aggregate_id = $${params.length}`;
  }

  if (input.orgId !== undefined) {
    if (input.orgId === null) {
      whereClause += " AND org_id IS NULL";
    } else {
      params.push(input.orgId);
      whereClause += ` AND org_id = $${params.length}`;
    }
  }

  if (input.since) {
    const parsedCursor = parseCursor(input.since);
    if (parsedCursor) {
      params.push(parsedCursor.occurredAt, parsedCursor.id);
      whereClause += `
        AND (
          occurred_at > $${params.length - 1}
          OR (occurred_at = $${params.length - 1} AND id > $${params.length})
        )`;
    } else {
      const sinceDate = new Date(input.since);
      if (Number.isNaN(sinceDate.getTime())) {
        throw new Error("Invalid cursor/timestamp");
      }
      params.push(sinceDate.toISOString());
      whereClause += ` AND occurred_at > $${params.length}`;
    }
  }

  const result = await query<ACXEventRow>(
    `SELECT id, type, aggregate_type, aggregate_id, occurred_at, trace_id, payload, version
     FROM acx_events
     WHERE ${whereClause}
     ORDER BY occurred_at ASC, id ASC
     LIMIT $${params.length + 1}`,
    [...params, limit + 1],
  );

  const rows = result.rows;
  const items = rows.slice(0, limit).map(normalizeOccurredAt);
  const nextCursor = rows.length > limit ? encodeCursor(items[items.length - 1]!) : null;

  return { items, nextCursor };
}
