import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { type Query, type SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { type CodexOptions } from "@openai/codex-sdk";

type AgentRunStatus = "success" | "failed";

const DEFAULT_TOOLS = ["Read", "Grep", "Glob", "Bash", "Edit", "Write"] as const;
const DEFAULT_MODEL = "claude-opus-4-6";
const CLAUDE_OPUS_4_7_MODEL = "claude-opus-4-7";
const CODEX_MODEL = "gpt-5.3-codex";
const LEGACY_CODEX_MODEL = "codex-5.3";
const GPT_5_5_MODEL = "gpt-5.5";
const GPT_5_4_MODEL = "gpt-5.4";
const ALLOWED_ASSISTANT_MODELS = ["claude-opus-4-6", CLAUDE_OPUS_4_7_MODEL, "claude-sonnet-4-6", CODEX_MODEL, LEGACY_CODEX_MODEL, GPT_5_5_MODEL, GPT_5_4_MODEL] as const;
type AssistantModel = (typeof ALLOWED_ASSISTANT_MODELS)[number];
export type AgentProvider = "claude" | "codex" | "unknown";

export interface AgentRuntimeMessage {
  provider: AgentProvider;
  kind?: string;
  text?: string;
  raw: unknown;
}

export type { AssistantModel };

export interface AgentRunPlanChange {
  target_table: string;
  operation: "Create" | "Update" | "Delete";
  target_id: Record<string, unknown>;
  previous: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  messages: string[];
  changes: AgentRunPlanChange[];
  error?: string;
}

export interface OpenShipBundleSnapshotEntry {
  path: string;
  hash: string;
  size: number;
}

interface OpenShipBundleSnapshotOptions {
  ignoreFileNames?: string[];
  ignoreDirectoryNames?: string[];
  ignoreFileNamePatterns?: RegExp[];
}

export interface ResolveThreadWorkspacePathInput {
  projectId: string;
  threadId: string;
  baseDir?: string;
}

function normalizeAssistantModel(rawModel: string | undefined): AssistantModel {
  if (rawModel === CLAUDE_OPUS_4_7_MODEL) return CLAUDE_OPUS_4_7_MODEL;
  if (rawModel === "claude-sonnet-4-6") return "claude-sonnet-4-6";
  if (rawModel === CODEX_MODEL || rawModel === LEGACY_CODEX_MODEL) return CODEX_MODEL;
  if (rawModel === GPT_5_5_MODEL) return GPT_5_5_MODEL;
  if (rawModel === GPT_5_4_MODEL) return GPT_5_4_MODEL;
  return DEFAULT_MODEL;
}

interface BaseRunAgentInput {
  prompt: string;
  cwd: string;
  allowedTools?: string[];
  systemPrompt?: string;
  model?: string;
  onMessage?: (message: AgentRuntimeMessage) => void;
}

export interface RunClaudeAgentInput extends BaseRunAgentInput {
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return typeof value === "object" && value !== null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

function normalizeCodexError(error: unknown): string {
  if (error instanceof Error) return error.message || "Unknown codex execution error.";
  if (typeof error === "string") return error;
  return "Unknown codex execution error.";
}

type CodexInvocationFailure = {
  name: string;
  error: string;
};

function isCodexDebugEnabled(): boolean {
  return (
    process.env.ACX_DEBUG_CODEX === "1"
    || process.env.ACX_DEBUG_CODEx === "1"
    || process.env.ACX_DEBUG_AGENT_RUNTIME === "1"
  );
}

async function runCodexAgent(input: BaseRunAgentInput): Promise<AgentRunResult> {
  const messages: string[] = [];
  try {
    const { Codex } = await import("@openai/codex-sdk");
    const options: CodexOptions = {}
    const model = normalizeAssistantModel(input.model);

    const codex = new Codex(options);
    const thread = codex.startThread({
      model,
      workingDirectory: input.cwd,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
    });
    const r = await thread.run([{
      type: 'text',
      text: input.systemPrompt || ''
    }, {
      type: 'text',
      text: input.prompt
    }]);

    await emitProviderOutput(r.finalResponse, "codex", input.onMessage, messages);

    return {
      status: "success",
      messages: messages.length > 0 ? messages : ["Execution completed."],
      changes: [],
    };
  } catch (error: unknown) {
    const message = normalizeCodexError(error);
    return {
      status: "failed",
      messages: messages.length > 0 ? [...messages, `Execution failed: ${message}`] : ["Execution failed."],
      changes: [],
      error: message,
    };
  }
}

export interface RunAgentInput extends BaseRunAgentInput {
}

export async function runAgent(input: RunAgentInput): Promise<AgentRunResult> {
  const model = normalizeAssistantModel(input.model);
  if (model === CODEX_MODEL || model === GPT_5_5_MODEL || model === GPT_5_4_MODEL) {
    return runCodexAgent({
      ...input,
      model,
    });
  }
  return runClaudeAgent({
    ...input,
    model,
  });
}

export function resolveThreadWorkspacePath(input: ResolveThreadWorkspacePathInput): string {
  const baseDir = input.baseDir?.trim() || join(homedir(), ".acx", "projects");
  return join(baseDir, input.projectId, input.threadId);
}

function extractMessageText(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractMessageText(item, depth + 1));
  }

  if (typeof value === "object") {
    const typedValue = value as Record<string, unknown>;
    const candidates = [
      typedValue.text,
      typedValue.content,
      typedValue.message,
      typedValue.response,
      typedValue.result,
      typedValue.output,
      typedValue.aggregated_output,
      typedValue.items,
    ];
    return candidates.flatMap((entry) => extractMessageText(entry, depth + 1));
  }

  return [];
}

function inferRuntimeMessageKind(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return "text";
  if (typeof value !== "object") return undefined;

  const typedValue = value as Record<string, unknown>;
  if (typeof typedValue.type === "string") return typedValue.type;
  if (typeof typedValue.role === "string") return typedValue.role;
  if (typeof typedValue.kind === "string") return typedValue.kind;
  return undefined;
}

function toRuntimeMessages(value: unknown, provider: AgentProvider): AgentRuntimeMessage[] {
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    return value.flatMap((entry) => toRuntimeMessages(entry, provider));
  }

  const values = extractMessageText(value);
  const joined = values.map((entry) => entry.trim()).filter((entry) => entry.length > 0).join("\n");
  return [{
    provider,
    kind: inferRuntimeMessageKind(value),
    ...(joined.length > 0 ? { text: joined } : {}),
    raw: value,
  }];
}

async function emitProviderOutput(
  output: unknown,
  provider: AgentProvider,
  onMessage: ((message: AgentRuntimeMessage) => void) | undefined,
  messages: string[],
): Promise<void> {
  const emit = (value: unknown): void => {
    const normalizedMessages = toRuntimeMessages(value, provider);
    for (const normalizedMessage of normalizedMessages) {
      if (normalizedMessage.text) {
        messages.push(normalizedMessage.text);
      }
      if (onMessage) {
        onMessage(normalizedMessage);
      }
    }
  };

  if (isAsyncIterable<unknown>(output)) {
    for await (const message of output) {
      emit(message);
    }
    return;
  }

  emit(output);
}

const DEFAULT_IGNORE_FILE_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

const DEFAULT_IGNORE_DIRECTORY_NAMES = new Set([
  ".git",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
]);

const DEFAULT_IGNORE_FILE_PATTERNS = [
  /^\._/,            // macOS resource fork files
  /^\~/,             // editor backup names
  /~$/,              // editor backup suffix
  /\.swp$/i,         // vim swap files
  /\.tmp$/i,         // temp files
];

function shouldIgnoreFile(pathName: string, options?: OpenShipBundleSnapshotOptions): boolean {
  if (DEFAULT_IGNORE_FILE_NAMES.has(pathName)) return true;

  if (options?.ignoreFileNames?.includes(pathName)) return true;

  const ignoredPatterns = [
    ...DEFAULT_IGNORE_FILE_PATTERNS,
    ...(options?.ignoreFileNamePatterns ?? []),
  ];

  return ignoredPatterns.some((pattern) => pattern.test(pathName));
}

function shouldIgnoreDir(pathName: string, options?: OpenShipBundleSnapshotOptions): boolean {
  if (DEFAULT_IGNORE_DIRECTORY_NAMES.has(pathName)) return true;
  return options?.ignoreDirectoryNames?.includes(pathName) ?? false;
}

async function computeFileHash(path: string): Promise<{ hash: string; size: number }> {
  const contents = await readFile(path);
  return {
    hash: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    size: contents.length,
  };
}

async function walkOpenShipBundle(
  root: string,
  current: string,
  accumulator: OpenShipBundleSnapshotEntry[],
  options?: OpenShipBundleSnapshotOptions,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  const sortedEntries = entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sortedEntries) {
    if (shouldIgnoreFile(entry.name, options)) continue;
    const childPath = join(current, entry.name);

    if (entry.isDirectory()) {
      if (shouldIgnoreDir(entry.name, options)) continue;
      await walkOpenShipBundle(root, childPath, accumulator, options);
      continue;
    }

    if (!entry.isFile()) continue;

    const { hash, size } = await computeFileHash(childPath);
    const relativePath = relative(root, childPath).replace(/\\/g, "/");
    accumulator.push({
      path: relativePath,
      hash,
      size,
    });
  }
}

export async function snapshotOpenShipBundle(
  bundleDir: string,
  options?: OpenShipBundleSnapshotOptions,
): Promise<OpenShipBundleSnapshotEntry[]> {
  const normalized = resolve(bundleDir);

  try {
    const nodeStats = await stat(normalized);
    if (!nodeStats.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const snapshot: OpenShipBundleSnapshotEntry[] = [];
  await walkOpenShipBundle(normalized, normalized, snapshot, options);
  return snapshot.sort((left, right) => left.path.localeCompare(right.path));
}

export function diffOpenShipSnapshots(
  before: OpenShipBundleSnapshotEntry[],
  after: OpenShipBundleSnapshotEntry[],
): AgentRunPlanChange[] {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const paths = new Set<string>([
    ...beforeByPath.keys(),
    ...afterByPath.keys(),
  ]);
  const changes: AgentRunPlanChange[] = [];

  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right));

  for (const path of sortedPaths) {
    const oldEntry = beforeByPath.get(path);
    const newEntry = afterByPath.get(path);

    if (!oldEntry && newEntry) {
      changes.push({
        target_table: "OpenShipBundleFile",
        operation: "Create",
        target_id: { path },
        previous: null,
        current: { hash: newEntry.hash },
      });
      continue;
    }

    if (oldEntry && !newEntry) {
      changes.push({
        target_table: "OpenShipBundleFile",
        operation: "Delete",
        target_id: { path },
        previous: { hash: oldEntry.hash },
        current: null,
      });
      continue;
    }

    if (oldEntry && newEntry && oldEntry.hash !== newEntry.hash) {
      changes.push({
        target_table: "OpenShipBundleFile",
        operation: "Update",
        target_id: { path },
        previous: { hash: oldEntry.hash },
        current: { hash: newEntry.hash },
      });
    }
  }

  return changes;
}

export function summarizeOpenShipBundleChanges(changes: AgentRunPlanChange[]): string {
  let added = 0;
  let updated = 0;
  let deleted = 0;

  for (const change of changes) {
    if (change.operation === "Create") added += 1;
    else if (change.operation === "Update") updated += 1;
    else if (change.operation === "Delete") deleted += 1;
  }

  return `OpenShip changes: A=${added}, M=${updated}, D=${deleted}`;
}

export async function runClaudeAgent(input: RunClaudeAgentInput): Promise<AgentRunResult> {
  const model = normalizeAssistantModel(input.model);
  const cwd = input.cwd;
  await mkdir(cwd, { recursive: true });

  const allowedTools = input.allowedTools ?? Array.from(DEFAULT_TOOLS);
  const messages: string[] = [];

  const q = query({
    prompt: input.prompt,
    options: {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools,
      model,
      cwd,
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    },
  });

  try {
    await emitProviderOutput(q as AsyncIterable<unknown>, "claude", input.onMessage, messages);

    return {
      status: "success",
      messages: messages.length > 0 ? messages : ["Execution completed."],
      changes: [],
    };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown agent execution error.";

    return {
      status: "failed",
      messages: messages.length > 0 ? [...messages, `Execution failed: ${message}`] : ["Execution failed."],
      changes: [],
      error: message,
    };
  }
}

export type { Query, SDKMessage };
export type { AgentRunStatus };
