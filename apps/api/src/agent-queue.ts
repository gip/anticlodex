import { randomUUID } from "node:crypto";
import pool, { query } from "./db.js";
import type { AgentRunPlanChange, AgentRunResult } from "@acx/agent-runtime";

export type AgentRunMode = "direct" | "plan";
export type AgentRunStatus = "queued" | "running" | "success" | "failed" | "cancelled";
export type AgentRunResultStatus = AgentRunResult["status"];

export interface AgentRunRow {
  id: string;
  thread_id: string;
  project_id: string;
  requested_by_user_id: string | null;
  model: string;
  mode: AgentRunMode;
  plan_action_id: string | null;
  chat_message_id: string | null;
  prompt: string;
  system_prompt: string | null;
  status: AgentRunStatus;
  runner_id: string | null;
  run_result_status: AgentRunResultStatus | null;
  run_result_messages: string[] | null;
  run_result_changes: AgentRunPlanChange[] | null;
  run_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface EnqueueAgentRunParams {
  threadId: string;
  projectId: string;
  requestedByUserId: string | null;
  mode: AgentRunMode;
  model: string;
  planActionId: string | null;
  chatMessageId: string | null;
  prompt: string;
  systemPrompt?: string | null;
}

const DEFAULT_RUN_SLOT_WAIT_MS = 120000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export async function enqueueAgentRun(params: EnqueueAgentRunParams): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO agent_runs (
      id,
      thread_id,
      project_id,
      requested_by_user_id,
      model,
      mode,
      plan_action_id,
      chat_message_id,
      prompt,
      system_prompt
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      randomUUID(),
      params.threadId,
      params.projectId,
      params.requestedByUserId,
      params.model,
      params.mode,
      params.planActionId,
      params.chatMessageId,
      params.prompt,
      params.systemPrompt ?? null,
    ],
  );

  return result.rows[0]?.id ?? "";
}

export async function enqueueAgentRunWithWait(
  params: EnqueueAgentRunParams,
  maxWaitMs = DEFAULT_RUN_SLOT_WAIT_MS,
  pollIntervalMs = 500,
): Promise<string> {
  const startedAt = Date.now();
  while (true) {
    try {
      return await enqueueAgentRun(params);
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxWaitMs) {
        throw new Error("Timeout waiting for a free agent run slot on this thread");
      }
      await sleep(Math.min(pollIntervalMs, Math.max(100, maxWaitMs - elapsedMs)));
    }
  }
}

function mapQueryRow(row: AgentRunRow): AgentRunRow {
  if (!Array.isArray(row.run_result_messages)) {
    row.run_result_messages = [];
  }
  return row;
}

export async function claimNextAgentRun(runnerId: string): Promise<AgentRunRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query<AgentRunRow>(
      `WITH next_run AS (
        SELECT ar.id
        FROM agent_runs ar
        JOIN threads t ON t.id = ar.thread_id
        WHERE ar.status = 'queued'
          AND NOT EXISTS (
            SELECT 1
            FROM agent_runs ar2
            WHERE ar2.thread_id = ar.thread_id
              AND ar2.status = 'running'
          )
        ORDER BY ar.created_at
        FOR UPDATE OF ar, t
        SKIP LOCKED
        LIMIT 1
      )
      UPDATE agent_runs ar
      SET status = 'running',
          runner_id = $1,
          started_at = NOW(),
          updated_at = NOW(),
          run_error = NULL
      FROM next_run
      WHERE ar.id = next_run.id
      RETURNING
        ar.id,
        ar.thread_id,
        ar.project_id,
        ar.requested_by_user_id,
        ar.model,
        ar.mode,
        ar.plan_action_id,
        ar.chat_message_id,
        ar.prompt,
        ar.system_prompt,
        ar.status,
        ar.runner_id,
        ar.run_result_status,
        ar.run_result_messages,
        ar.run_result_changes,
        ar.run_error,
        ar.created_at,
        ar.started_at,
        ar.completed_at,
        ar.updated_at`,
      [runnerId],
    );

    await client.query("COMMIT");
    if (!result.rowCount) return null;
    return mapQueryRow(result.rows[0]);
  } catch (error: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignored
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function claimAgentRunById(runId: string, runnerId: string, threadId?: string): Promise<AgentRunRow | null> {
  try {
    const values = threadId ? [runnerId, runId, threadId] : [runnerId, runId];
    const whereClause = threadId ? "AND ar.thread_id = $3" : "";
    const claimedTransition = `
      (ar.status = 'queued' AND ar.runner_id IS DISTINCT FROM $1)
      OR (ar.status = 'running' AND ar.runner_id = $1)
    `;

    const result = await query<AgentRunRow>(
      `UPDATE agent_runs ar
          SET status = 'running',
              runner_id = $1,
              started_at = CASE WHEN ar.status = 'queued' THEN NOW() ELSE ar.started_at END,
              updated_at = NOW(),
              run_error = NULL
        WHERE ar.id = $2
          AND ${claimedTransition}
          ${whereClause}
      RETURNING
        ar.id,
        ar.thread_id,
        ar.project_id,
        ar.requested_by_user_id,
        ar.model,
        ar.mode,
        ar.plan_action_id,
        ar.chat_message_id,
        ar.prompt,
        ar.system_prompt,
        ar.status,
        ar.runner_id,
        ar.run_result_status,
        ar.run_result_messages,
        ar.run_result_changes,
        ar.run_error,
        ar.created_at,
        ar.started_at,
        ar.completed_at,
        ar.updated_at`,
      values,
    );

    if (!result.rowCount) return null;
    return mapQueryRow(result.rows[0]);
  } catch (error: unknown) {
    if (error instanceof Error && (error as { code?: string }).code === "23505") {
      // Unique constraint on active run per-thread.
      return null;
    }
    throw error;
  }
}

export async function getAgentRunById(runId: string): Promise<AgentRunRow | null> {
  const result = await query<AgentRunRow>(
    `SELECT
      id,
      thread_id,
      project_id,
      requested_by_user_id,
      model,
      mode,
      plan_action_id,
      chat_message_id,
      prompt,
      system_prompt,
      status,
      runner_id,
      run_result_status,
      run_result_messages,
      run_result_changes,
      run_error,
      created_at,
      started_at,
      completed_at,
      updated_at
    FROM agent_runs
    WHERE id = $1`,
    [runId],
  );
  return result.rowCount ? mapQueryRow(result.rows[0]) : null;
}

export interface AgentRunCompletionResult {
  status: AgentRunResult["status"];
  messages: string[];
  changes: AgentRunPlanChange[];
  error: string | null;
}

export async function waitForAgentRunCompletion(
  runId: string,
  maxWaitMs: number,
  pollIntervalMs: number,
): Promise<AgentRunCompletionResult | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const result = await query<{
      status: AgentRunStatus;
      run_result_status: AgentRunResultStatus | null;
      run_result_messages: string[] | null;
      run_result_changes: AgentRunPlanChange[] | null;
      run_error: string | null;
    }>(
      `SELECT status,
              run_result_status,
              run_result_messages,
              run_result_changes,
              run_error
         FROM agent_runs
        WHERE id = $1`,
      [runId],
    );

    const row = result.rows[0];
    if (!row) return null;

    if (row.status === "success" || row.status === "failed" || row.status === "cancelled") {
      const messages = Array.isArray(row.run_result_messages) && row.run_result_messages.length > 0
        ? row.run_result_messages
        : [row.run_error ?? "No execution output."];

      return {
        status: row.status === "cancelled" ? "failed" : row.run_result_status ?? row.status,
        messages,
        changes: row.run_result_changes ?? [],
        error: row.run_error,
      };
    }

    await sleep(pollIntervalMs);
  }

  return null;
}

export async function updateAgentRunResult(
  runId: string,
  status: AgentRunStatus,
  result: Pick<AgentRunResult, "status" | "messages" | "changes" | "error">,
  runnerError?: string,
  runnerId?: string,
): Promise<boolean> {
  const whereClause = runnerId
    ? "WHERE id = $6 AND status = 'running' AND runner_id = $7"
    : "WHERE id = $6 AND status = 'running'";
  const values: Array<unknown> = [
    status,
    result.status,
    result.messages,
    JSON.stringify(result.changes),
    runnerError ?? result.error ?? null,
    runId,
  ];
  if (runnerId) {
    values.push(runnerId);
  }

  const updateResult = await query(
    `UPDATE agent_runs
       SET status = $1,
           run_result_status = $2,
           run_result_messages = $3,
           run_result_changes = $4,
           run_error = COALESCE($5, run_error),
           completed_at = NOW(),
           updated_at = NOW()
     ${whereClause}`,
    values,
  );

  if (updateResult.rowCount === 0) {
    console.warn("[agent-queue] updateAgentRunResult no-op", {
      runId,
      status,
      runnerId,
      reason: "run already finalized or owned by different runner",
    });
    return false;
  }

  return true;
}
