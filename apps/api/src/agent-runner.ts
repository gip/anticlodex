import { mkdir, readFile, rm, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./db.js";
import { claimNextAgentRun, updateAgentRunResult } from "./agent-queue.js";
import {
  applyOpenShipBundleToThreadSystem,
  collectOpenShipBundleFiles,
  type OpenShipBundleFile,
} from "./openship-sync.js";
import {
  diffOpenShipSnapshots,
  type AgentRunPlanChange,
  resolveThreadWorkspacePath,
  runAgent,
  type AgentRunResult,
  snapshotOpenShipBundle,
  summarizeOpenShipBundleChanges,
} from "@acx/agent-runtime";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RUNNER_ID = process.env.ACX_AGENT_RUNNER_ID || "api-worker";
const OPENSHIP_BUNDLE_DIR_NAME = "openship";
const OPENSHIP_MANIFEST_FILE_NAME = "openship.yaml";
const OPENSHIP_ROOT_NODE_ID = "s.root";
const OPENSHIP_AGENT_SPEC_FILE_NAME = "SKILL.md";
const OPENSHIP_AGENT_LEGACY_SPEC_FILE_NAME = "SKILLS.md";
const OPENSHIP_BUNDLE_SPEC_FILE_NAME = "SKILLS.md";
const OPENSHIP_BUNDLE_SPEC_REL_DIR = "openship-specs-v1";
const OPENSHIP_AGENT_AGENTS_FILE_NAME = "AGENTS.md";
const OPENSHIP_TEMPLATE_SPEC_CANDIDATES = [
  resolve(process.cwd(), "skills", "openship-specs-v1", OPENSHIP_AGENT_SPEC_FILE_NAME),
  resolve(process.cwd(), "skills", "openship-specs-v1", OPENSHIP_AGENT_LEGACY_SPEC_FILE_NAME),
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "skills",
    "openship-specs-v1",
    OPENSHIP_AGENT_SPEC_FILE_NAME,
  ),
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "skills",
    "openship-specs-v1",
    OPENSHIP_AGENT_LEGACY_SPEC_FILE_NAME,
  ),
];
const OPENSHIP_AGENT_AGENTS_CANDIDATES = [
  resolve(process.cwd(), "packages", "agent-runtime", OPENSHIP_AGENT_AGENTS_FILE_NAME),
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "packages",
    "agent-runtime",
    OPENSHIP_AGENT_AGENTS_FILE_NAME,
  ),
];

const SYSTEM_PROMPT_CONCERN = "__system_prompt__";
const YAML_INDENT = "  ";

function toBundleNodeId(nodeId: string, systemRootNodeId: string): string {
  return nodeId === systemRootNodeId ? OPENSHIP_ROOT_NODE_ID : nodeId;
}

interface SystemRow {
  id: string;
  name: string;
  spec_version: string;
  root_node_id: string;
}

interface ConcernRow {
  name: string;
  position: number;
  scope: string | null;
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  parent_id: string | null;
  metadata: Record<string, unknown>;
}

interface EdgeRow {
  id: string;
  type: string;
  from_node_id: string;
  to_node_id: string;
  metadata: Record<string, unknown>;
}

interface MatrixRefRow {
  node_id: string;
  concern: string;
  ref_type: "Document" | "Skill" | "Prompt";
  doc_hash: string;
}

interface DocumentRow {
  hash: string;
  kind: "Document" | "Skill" | "Prompt";
  title: string;
  language: string;
  text: string;
  supersedes: string | null;
  source_type: string;
  source_url: string | null;
  source_external_id: string | null;
  source_metadata: Record<string, unknown> | null;
  source_connected_user_id: string | null;
}

interface ArtifactRow {
  id: string;
  node_id: string;
  concern: string;
  type: "Summary" | "Code" | "Docs";
  language: string;
  text: string | null;
}

interface ArtifactFileRow {
  artifact_id: string;
  file_hash: string;
  file_path: string;
  file_content: string;
}

interface MatrixCellArtifacts {
  documentRefs: string[];
  skillRefs: string[];
  promptRefs?: string[];
}

function yamlEscape(value: string): string {
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalarValue(value: unknown): value is null | undefined | string | number | boolean {
  return (
    value === null
    || value === undefined
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  );
}

function yamlScalarValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return yamlEscape(value);
  return yamlEscape(String(value));
}

function yamlToLines(value: unknown, indent = 0): string[] {
  const pad = YAML_INDENT.repeat(indent);
  if (isScalarValue(value)) {
    return [`${pad}${yamlScalarValue(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    return value.flatMap((item) => {
      if (isScalarValue(item)) {
        return [`${pad}- ${yamlScalarValue(item)}`];
      }
      const nested = yamlToLines(item, indent + 1);
      return [`${pad}-`, ...nested];
    });
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return [`${pad}{}`];
    return keys.flatMap((key) => {
      const child = value[key];
      if (isScalarValue(child)) {
        return [`${pad}${yamlEscape(key)}: ${yamlScalarValue(child)}`];
      }
      if (Array.isArray(child) && child.length === 0) {
        return [`${pad}${yamlEscape(key)}: []`];
      }
      return [`${pad}${yamlEscape(key)}:`, ...yamlToLines(child, indent + 1)];
    });
  }
  return [`${pad}${yamlEscape(String(value))}`];
}

function toYaml(value: unknown): string {
  return yamlToLines(value).join("\n");
}

function safeRelativePath(filePath: string, fallback: string): string | null {
  const normalized = normalize(filePath).replace(/\\/g, "/");
  if (!normalized || normalized === ".") {
    return fallback;
  }
  if (isAbsolute(normalized) || normalized.startsWith("..")) {
    return null;
  }
  const unixPath = posix.normalize(normalized);
  if (unixPath === "." || unixPath.startsWith("..") || unixPath.includes("../") || /[A-Za-z]:/.test(unixPath)) {
    return null;
  }
  return unixPath.replace(/^\.\//, "");
}

function splitFrontMatter(document: DocumentRow): string {
  const parts = [
    "---",
    `kind: ${yamlEscape(document.kind)}`,
    `hash: ${yamlEscape(document.hash)}`,
    `title: ${yamlEscape(document.title)}`,
    `language: ${yamlEscape(document.language)}`,
  ];

  if (document.supersedes) {
    parts.push(`supersedes: ${yamlEscape(document.supersedes)}`);
  }

  parts.push("---");
  parts.push("");
  parts.push(document.text ?? "");
  return `${parts.join("\n")}\n`;
}

function splitArtifactFrontMatter(artifact: ArtifactRow): string {
  const artifactText = artifact.text ?? "";
  const parts = [
    "---",
    `id: ${yamlEscape(artifact.id)}`,
    `nodeId: ${yamlEscape(artifact.node_id)}`,
    `concern: ${yamlEscape(artifact.concern)}`,
    `type: ${yamlEscape(artifact.type)}`,
    `language: ${yamlEscape(artifact.language)}`,
    "---",
    "",
    artifactText,
  ];
  return `${parts.join("\n")}\n`;
}

async function copyOpenShipSpec(bundleDir: string, workspace: string): Promise<void> {
  let text: string | null = null;
  for (const candidate of OPENSHIP_TEMPLATE_SPEC_CANDIDATES) {
    const specText = await readFile(candidate, "utf8").catch(() => null);
    if (specText === null) continue;
    text = specText;
    break;
  }

  if (text === null) {
    console.warn("[agent-runner] OpenShip spec not found in candidate paths; skipping spec injection");
    return;
  }

  await writeFileInDir(
    join(bundleDir, OPENSHIP_BUNDLE_SPEC_FILE_NAME),
    text,
  );
  await writeFileInDir(
    join(bundleDir, "skills", OPENSHIP_BUNDLE_SPEC_REL_DIR, OPENSHIP_AGENT_SPEC_FILE_NAME),
    text,
  );
  await writeFileInDir(
    join(workspace, "skills", OPENSHIP_BUNDLE_SPEC_REL_DIR, OPENSHIP_AGENT_SPEC_FILE_NAME),
    text,
  );
}

async function copyOpenShipAgentsBootstrap(targetDir: string): Promise<void> {
  for (const candidate of OPENSHIP_AGENT_AGENTS_CANDIDATES) {
    const text = await readFile(candidate, "utf8").catch(() => null);
    if (text === null) continue;

    await writeFile(join(targetDir, OPENSHIP_AGENT_AGENTS_FILE_NAME), text, "utf8");
    return;
  }

  console.warn("[agent-runner] AGENTS.md not found in candidates; skipping bootstrap injection");
}

async function writeFileInDir(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

export async function generateOpenShipFileBundle(threadId: string, workspace: string): Promise<string> {
  const bundleDir = join(workspace, OPENSHIP_BUNDLE_DIR_NAME);

  const systemRows = await query<SystemRow>(`
    SELECT id, name, spec_version, root_node_id
    FROM systems
    WHERE id = thread_current_system($1)
  `, [threadId]);

  const system = systemRows.rows[0];
  if (!system) {
    throw new Error(`Unable to resolve system for thread ${threadId}`);
  }

  const [
    concernsResult,
    nodesResult,
    edgesResult,
    matrixRefsResult,
    documentsResult,
    artifactsResult,
    artifactFilesResult,
  ] = await Promise.all([
    query<ConcernRow>(
      `SELECT name, position, scope
       FROM concerns
       WHERE system_id = $1
         AND scope IS DISTINCT FROM 'system'
         AND name <> $2
       ORDER BY position, name`,
      [system.id, SYSTEM_PROMPT_CONCERN],
    ),
    query<NodeRow>(
      `SELECT id, kind, name, parent_id, metadata
       FROM nodes
       WHERE system_id = $1
       ORDER BY id`,
      [system.id],
    ),
    query<EdgeRow>(
      `SELECT id, type, from_node_id, to_node_id, metadata
       FROM edges
       WHERE system_id = $1
       ORDER BY id`,
      [system.id],
    ),
    query<MatrixRefRow>(
      `SELECT mr.node_id, mr.concern, mr.ref_type, mr.doc_hash
       FROM matrix_refs mr
       WHERE mr.system_id = $1
       ORDER BY mr.node_id, mr.concern, mr.ref_type, mr.doc_hash`,
      [system.id],
    ),
    query<DocumentRow>(
      `SELECT hash, kind, title, language, text, supersedes, source_type, source_url,
              source_external_id, source_metadata, source_connected_user_id
       FROM documents
       WHERE system_id = $1
         AND kind IN ('Document'::doc_kind, 'Skill'::doc_kind, 'Prompt'::doc_kind)
       ORDER BY kind, title, hash`,
      [system.id],
    ),
    query<ArtifactRow>(
      `SELECT id, node_id, concern, type, language, text
       FROM artifacts
       WHERE system_id = $1
       ORDER BY node_id, concern, type, id`,
      [system.id],
    ),
    query<ArtifactFileRow>(
      `SELECT af.artifact_id, af.file_hash, fc.file_path, fc.file_content
       FROM artifact_files af
       JOIN file_contents fc ON fc.hash = af.file_hash
       WHERE af.system_id = $1`,
      [system.id],
    ),
  ]);

  const concernRows = [...concernsResult.rows];
  const matrixConcernNames = new Set(concernRows.map((concern) => concern.name));
  const concernByName = new Map<string, number>();
  for (const concern of concernRows) {
    concernByName.set(concern.name, concern.position);
  }

  const documentsByHash = new Map<string, DocumentRow>();
  for (const document of documentsResult.rows) {
    documentsByHash.set(document.hash, document);
  }

  const artifactFilesByArtifactId = new Map<string, ArtifactFileRow[]>();
  for (const row of artifactFilesResult.rows) {
    const list = artifactFilesByArtifactId.get(row.artifact_id) ?? [];
    list.push(row);
    artifactFilesByArtifactId.set(row.artifact_id, list);
  }

  const nodeMatrix = new Map<string, Map<string, MatrixCellArtifacts>>();
  const rootPromptRefs = new Set<string>();
  for (const ref of matrixRefsResult.rows) {
    const byNode = nodeMatrix.get(ref.node_id) ?? new Map<string, MatrixCellArtifacts>();
    const byConcern = byNode.get(ref.concern) ?? {
      documentRefs: [],
      skillRefs: [],
      promptRefs: [],
    };

    if (ref.ref_type === "Document") {
      byConcern.documentRefs.push(ref.doc_hash);
      if (!matrixConcernNames.has(ref.concern)) {
        matrixConcernNames.add(ref.concern);
      }
      concernByName.set(ref.concern, Number.MAX_SAFE_INTEGER);
    } else if (ref.ref_type === "Skill") {
      byConcern.skillRefs.push(ref.doc_hash);
      if (!matrixConcernNames.has(ref.concern)) {
        matrixConcernNames.add(ref.concern);
      }
      concernByName.set(ref.concern, Number.MAX_SAFE_INTEGER);
    } else if (ref.ref_type === "Prompt" && ref.concern === SYSTEM_PROMPT_CONCERN && ref.node_id === system.root_node_id) {
      rootPromptRefs.add(ref.doc_hash);
    }

    byNode.set(ref.concern, byConcern);
    nodeMatrix.set(ref.node_id, byNode);
  }

  const concernsInMatrix = Array.from(matrixConcernNames);
  const manifestConcerns = concernsInMatrix.sort((left, right) => {
    const leftPos = concernByName.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightPos = concernByName.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftPos !== rightPos) return leftPos - rightPos;
    return left.localeCompare(right);
  }).filter((concern) => concern !== SYSTEM_PROMPT_CONCERN);

  const artifactsByNode = new Map<string, ArtifactRow[]>();
  for (const artifact of artifactsResult.rows) {
    const list = artifactsByNode.get(artifact.node_id) ?? [];
    list.push(artifact);
    artifactsByNode.set(artifact.node_id, list);
  }

  const orderConcerns = (concerns: Iterable<string>): string[] => {
    const list = [...concerns].filter((concern) => concern !== SYSTEM_PROMPT_CONCERN);
    return list.sort((left, right) => {
      const leftPos = concernByName.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightPos = concernByName.get(right) ?? Number.MAX_SAFE_INTEGER;
      if (leftPos !== rightPos) return leftPos - rightPos;
      return left.localeCompare(right);
    });
  };

  await rm(bundleDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });

  await writeFileInDir(
    join(bundleDir, OPENSHIP_MANIFEST_FILE_NAME),
    toYaml({
      specVersion: system.spec_version,
      systemNodeId: OPENSHIP_ROOT_NODE_ID,
      systemName: system.name,
      concerns: manifestConcerns,
      ...(rootPromptRefs.size > 0 ? { systemPromptRefs: [...rootPromptRefs].sort() } : {}),
    }) + "\n",
  );
  await copyOpenShipSpec(bundleDir, workspace);
  await copyOpenShipAgentsBootstrap(bundleDir);
  await copyOpenShipAgentsBootstrap(workspace);

  for (const document of documentsByHash.values()) {
    if (document.kind !== "Document" && document.kind !== "Skill") {
      continue;
    }
    const target = join(bundleDir, "inputs", document.kind.toLowerCase() + "s", `${document.hash}.md`);
    await writeFileInDir(target, splitFrontMatter(document));
  }

  await writeFileInDir(
    join(bundleDir, "edges", "edges.yaml"),
    toYaml({
      edges: edgesResult.rows.map((edge) => ({
        id: edge.id,
        type: edge.type,
        fromNodeId: toBundleNodeId(edge.from_node_id, system.root_node_id),
        toNodeId: toBundleNodeId(edge.to_node_id, system.root_node_id),
        ...(edge.metadata && Object.keys(edge.metadata).length > 0 ? { metadata: edge.metadata } : {}),
      })),
    }) + "\n",
  );

  for (const node of nodesResult.rows) {
    const bundleNodeId = toBundleNodeId(node.id, system.root_node_id);
    const nodeArtifacts = artifactsByNode.get(node.id) ?? [];
    const byNode = nodeMatrix.get(node.id);
    const matrix: Record<string, MatrixCellArtifacts> = {};

    for (const concern of orderConcerns(byNode ? byNode.keys() : [])) {
      const refs = byNode?.get(concern);
      if (!refs) continue;

      const docRefs = [...new Set(refs.documentRefs)].filter((refHash) => documentsByHash.get(refHash)?.kind === "Document");
      const skillRefs = [...new Set(refs.skillRefs)].filter((refHash) => documentsByHash.get(refHash)?.kind === "Skill");

      if (docRefs.length === 0 && skillRefs.length === 0) continue;
      matrix[concern] = {
        documentRefs: docRefs.sort(),
        skillRefs: skillRefs.sort(),
      };
    }

    const summary: Array<{ id: string; concern: string; files: string[]; language: string; text: string | null }> = [];
    const docs: Array<{ id: string; concern: string; files: string[]; language: string; text: string | null }> = [];
    const code: Array<{ id: string; concern: string; files: string[]; language: string; text: string | null }> = [];

    const nodeBasePath = join(bundleDir, "nodes", bundleNodeId);

    for (const artifact of nodeArtifacts) {
      if (artifact.type === "Summary") {
        summary.push({
          id: artifact.id,
          concern: artifact.concern,
          files: [],
          language: artifact.language,
          text: artifact.text,
        });
      } else if (artifact.type === "Docs") {
        docs.push({
          id: artifact.id,
          concern: artifact.concern,
          files: [],
          language: artifact.language,
          text: artifact.text,
        });
      } else {
        const fileRows = artifactFilesByArtifactId.get(artifact.id) ?? [];
        const filePaths = fileRows
          .map((row) => safeRelativePath(row.file_path, `file-${artifact.id}.txt`))
          .filter((value): value is string => value !== null)
          .sort();
        code.push({
          id: artifact.id,
          concern: artifact.concern,
          files: filePaths,
          language: artifact.language,
          text: artifact.text,
        });
      }
    }

    const nodeManifest = toYaml({
      id: bundleNodeId,
      kind: node.kind,
      name: node.name,
      ...(node.parent_id
        ? { parentId: toBundleNodeId(node.parent_id, system.root_node_id) }
        : {}),
      metadata: node.metadata ?? {},
      ...(Object.keys(matrix).length > 0 ? { matrix } : { matrix: {} }),
      artifacts: {
        ...(summary.length > 0 ? { Summary: summary.map((artifact) => artifact.id) } : {}),
        ...(docs.length > 0 ? { Docs: docs.map((artifact) => artifact.id) } : {}),
        ...(code.length > 0
          ? {
              Code: code.map((artifact) => ({
                id: artifact.id,
                concern: artifact.concern,
                files: artifact.files,
              })),
            }
          : {}),
      },
      ...(node.id === system.root_node_id && rootPromptRefs.size > 0
        ? { systemPromptRefs: [...rootPromptRefs].sort() }
        : {}),
    }) + "\n";

    await writeFileInDir(join(nodeBasePath, "node.yaml"), nodeManifest);

    for (const artifact of summary) {
      const target = join(nodeBasePath, "artifacts", "summary", `${artifact.id}.md`);
      await writeFileInDir(
        target,
        splitArtifactFrontMatter({
          id: artifact.id,
          node_id: bundleNodeId,
          concern: artifact.concern,
          type: "Summary",
          language: artifact.language,
          text: artifact.text,
        }),
      );
    }

    for (const artifact of docs) {
      const target = join(nodeBasePath, "artifacts", "docs", `${artifact.id}.md`);
      await writeFileInDir(
        target,
        splitArtifactFrontMatter({
          id: artifact.id,
          node_id: bundleNodeId,
          concern: artifact.concern,
          type: "Docs",
          language: artifact.language,
          text: artifact.text,
        }),
      );
    }

    for (const artifact of code) {
      const fileRows = artifactFilesByArtifactId.get(artifact.id) ?? [];
      for (const [index, fileRow] of fileRows.entries()) {
        const safeName = safeRelativePath(fileRow.file_path, `file-${artifact.id}-${index}.txt`);
        if (!safeName) continue;
        const target = join(nodeBasePath, "artifacts", "code", safeName);
        await writeFileInDir(target, fileRow.file_content);
      }
    }
  }

  console.info("[agent-runner] generated openship file bundle", {
    threadId,
    bundleDir,
    files: {
      documents: documentsByHash.size,
      nodes: nodesResult.rows.length,
      edges: edgesResult.rows.length,
      artifacts: artifactsResult.rows.length,
    },
  });

  return bundleDir;
}

type QueueStatus = "success" | "failed";

interface OpenShipBundleCandidate {
  path: string;
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    const maybeDir = await stat(value);
    return maybeDir.isDirectory();
  } catch {
    return false;
  }
}

async function findOpenShipBundleDirectory(workspace: string): Promise<string> {
  const preferred = join(workspace, "openship");
  if (await isDirectory(preferred)) {
    console.info("[agent-runner] bundle directory resolved", {
      workspace,
      openShipBundleDir: preferred,
      reason: "workspace/openship exists",
    });
    return preferred;
  }

  const queue: OpenShipBundleCandidate[] = [{ path: workspace }];
  const visited = new Set<string>([workspace]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const entries = await readdir(current.path, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;

    const hasManifest = entries.some(
      (entry) => entry.isFile() && entry.name === OPENSHIP_MANIFEST_FILE_NAME,
    );
    if (hasManifest) {
      console.info("[agent-runner] bundle directory resolved", {
        workspace,
        openShipBundleDir: current.path,
        reason: "openship.yaml found",
      });
      return current.path;
    }

    const childDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ path: join(current.path, entry.name) }))
      .filter((entry) => !visited.has(entry.path))
      .filter((entry) => !entry.path.includes(`${"/.git/"}`))
      .filter((entry) => !entry.path.includes(`${"/node_modules/"}`))
      .sort((left, right) => left.path.localeCompare(right.path));

    for (const childDir of childDirs) {
      visited.add(childDir.path);
      queue.push(childDir);
    }
  }

  console.info("[agent-runner] bundle directory resolved", {
    workspace,
    openShipBundleDir: workspace,
    reason: "no openship container found; using workspace fallback",
  });
  return workspace;
}

interface RunClaudeAgentResult {
  status: QueueStatus;
  messages: string[];
  changes: AgentRunPlanChange[];
  error?: string;
  openShipBundleFiles: OpenShipBundleFile[];
}

async function runClaudeAgentWithBundleDiff(
  runPrompt: string,
  systemPrompt: string | null,
  workspace: string,
  threadId: string,
  model: string | undefined,
): Promise<RunClaudeAgentResult> {
  const openShipBundleDir = join(workspace, OPENSHIP_BUNDLE_DIR_NAME);
  console.info("[agent-runner] bundle generation start", {
    threadId,
    workspace,
    openShipBundleDir,
  });

  try {
    await generateOpenShipFileBundle(threadId, workspace);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      messages: [`OpenShip pre-run generation failed: ${message}`],
      changes: [],
      error: message,
      openShipBundleFiles: [],
    };
  }

  const preRunDir = await findOpenShipBundleDirectory(workspace);
  console.info("[agent-runner] bundle pre-run snapshot start", {
    openShipBundleDir: preRunDir,
    workspace,
  });
  const before = await snapshotOpenShipBundle(preRunDir);
  if (before.length === 0) {
    console.warn("[agent-runner] pre-run bundle empty", {
      openShipBundleDir: preRunDir,
    });
  }
  let runResult: RunClaudeAgentResult;
  try {
    console.info("[agent-runner] invoking agent", {
      threadId,
      openShipBundleDir,
      workspace,
      systemPrompt,
      model,
    });
    const result = await runAgent({
      prompt: runPrompt,
      cwd: workspace,
      model,
      systemPrompt: systemPrompt ?? undefined,
      allowedTools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write"],
    });
    runResult = {
      status: result.status,
      messages: result.messages,
      changes: result.changes,
      error: result.error,
      openShipBundleFiles: [],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    runResult = {
      status: "failed",
      messages: [`Execution failed: ${error instanceof Error ? error.message : String(error)}`],
      changes: [],
      error: message,
      openShipBundleFiles: [],
    };
  }

  const after = await snapshotOpenShipBundle(preRunDir);
  const fileChanges = diffOpenShipSnapshots(before, after);

  if (fileChanges.length === 0) {
    console.info("[agent-runner] OpenShip bundle diff result", {
      threadId,
      openShipBundleDir: preRunDir,
      changed: 0,
      message: "No files changed in OpenShip bundle.",
    });
  } else {
    console.info("[agent-runner] OpenShip bundle diff result", {
      threadId,
      openShipBundleDir: preRunDir,
      changed: fileChanges.length,
      changes: fileChanges,
    });
  }

  if (runResult.changes.length === 0) {
    runResult.changes = fileChanges;
  } else if (fileChanges.length > 0) {
    runResult.changes = [...runResult.changes, ...fileChanges];
  }

  const summary = summarizeOpenShipBundleChanges(fileChanges);
  runResult.messages = [
    ...runResult.messages,
    summary,
  ];

  let openShipBundleFiles: OpenShipBundleFile[] = [];
  if (runResult.status === "success" && fileChanges.length > 0) {
    try {
      openShipBundleFiles = await collectOpenShipBundleFiles(preRunDir);
    } catch (error: unknown) {
      return {
        status: "failed",
        messages: [...runResult.messages, `OpenShip reconciliation snapshot failed: ${runSummaryError(error)}`],
        changes: runResult.changes,
        error: runSummaryError(error),
        openShipBundleFiles: [],
      };
    }
  }

  return {
    ...runResult,
    openShipBundleFiles,
  };
}

async function applyOpenShipBundleResult(
  threadId: string,
  result: RunClaudeAgentResult,
): Promise<RunClaudeAgentResult> {
  if (result.status !== "success" || result.openShipBundleFiles.length === 0) {
    return result;
  }

  try {
    await applyOpenShipBundleToThreadSystem({
      threadId,
      bundleFiles: result.openShipBundleFiles,
    });
  } catch (error: unknown) {
    return {
      status: "failed",
      messages: [...result.messages, `OpenShip reconciliation failed: ${runSummaryError(error)}`],
      changes: result.changes,
      error: runSummaryError(error),
      openShipBundleFiles: [],
    };
  }

  return result;
}
async function runAgentAndApplyResult(
  runPrompt: string,
  systemPrompt: string | null,
  workspace: string,
  threadId: string,
  model: string | undefined,
): Promise<RunClaudeAgentResult> {
  const runResult = await runClaudeAgentWithBundleDiff(runPrompt, systemPrompt, workspace, threadId, model);
  const reconciled = await applyOpenShipBundleResult(threadId, runResult);
  return reconciled;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AgentRunnerOptions {
  pollIntervalMs?: number;
  runnerId?: string;
}

function runSummaryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startAgentRunner(options: AgentRunnerOptions = {}): () => void {
  const pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0
    ? options.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  const runnerId = options.runnerId?.trim() || DEFAULT_RUNNER_ID;

  let stopped = false;

  const processOnce = async () => {
    if (stopped) return;

    const run = await claimNextAgentRun(runnerId);
    if (!run) return;

    try {
      const workspace = resolveThreadWorkspacePath({
        projectId: run.project_id,
        threadId: run.thread_id,
        baseDir: process.env.ACX_PROJECTS_ROOT,
      });

      console.info("[agent-runner] starting", {
        runId: run.id,
        threadId: run.thread_id,
        workspace,
      });

      const result = await runAgentAndApplyResult(
        run.prompt,
        run.system_prompt ?? null,
        workspace,
        run.thread_id,
        run.model,
      );

      await updateAgentRunResult(
        run.id,
        result.status === "failed" ? "failed" : "success",
        result,
        undefined,
        runnerId,
      );
      console.info("[agent-runner] completed", {
        runId: run.id,
        threadId: run.thread_id,
        status: result.status,
      });
    } catch (error: unknown) {
      const message = runSummaryError(error);
      console.error("[agent-runner] failed", { runId: run.id, threadId: run.thread_id, error: message });
      await updateAgentRunResult(
        run.id,
        "failed",
        {
          status: "failed",
          messages: [`Execution failed: ${message}`],
          changes: [],
          error: message,
        },
        message,
        runnerId,
      );
    }
  };

  const runLoop = async () => {
    while (!stopped) {
      try {
        await processOnce();
      } catch (error: unknown) {
        console.error("[agent-runner] poller failed", { error: runSummaryError(error) });
      }
      if (stopped) break;
      await sleep(pollIntervalMs);
    }
    console.info("[agent-runner] stopped", { runnerId });
  };

  void runLoop();

  const stop = (): void => {
    stopped = true;
  };

  return stop;
}
