import { cp, lstat, mkdir, readFile, readlink, rm, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, posix, relative, resolve } from "node:path";
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
import {
  compareUtf8,
  computeSourcesDigest,
  sha256Hex,
  validateSources,
  validateSystems,
  type SourceFileMetadata,
  type SourcesBundle,
  type SourcesManifest,
  type SystemsDocument,
  type VerifiedSources,
} from "@openship/protocol";
import { applyOpenShipV1DocumentToThread, exportSystems } from "./openship-v1.js";
import pool from "./db.js";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RUNNER_ID = process.env.ACX_AGENT_RUNNER_ID || "api-worker";
const OPENSHIP_BUNDLE_DIR_NAME = "openship";
const OPENSHIP_MANIFEST_FILE_NAME = "openship.yaml";
const OPENSHIP_ROOT_NODE_ID = "s.root";
const OPENSHIP_AGENT_AGENTS_FILE_NAME = "AGENTS.md";
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
const OPENSHIP_V1_SKILL_CANDIDATES = [
  resolve(process.cwd(), "skills", "openship"),
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills", "openship"),
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

function isUtf8Source(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function mediaTypeForPath(path: string, text: boolean): string {
  if (!text) return "application/octet-stream";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".md") || path.endsWith(".mdx")) return "text/markdown";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".jsx")) return "text/plain";
  return "text/plain";
}

async function findCanonicalOpenShipSkill(): Promise<string> {
  for (const candidate of OPENSHIP_V1_SKILL_CANDIDATES) {
    try {
      if ((await stat(join(candidate, "SKILL.md"))).isFile()) return candidate;
    } catch {
      // Try the package-relative candidate.
    }
  }
  throw new Error("The synchronized canonical skills/openship tree is missing.");
}

async function materializeOpenShipV1Workspace(
  workspace: string,
  document: SystemsDocument,
  verified: VerifiedSources,
): Promise<void> {
  const projectDir = join(workspace, "project");
  const controlDir = join(workspace, "control");
  await rm(projectDir, { recursive: true, force: true });
  await rm(controlDir, { recursive: true, force: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(controlDir, { recursive: true });

  for (const file of verified.files.filter((entry) => entry.metadata.type === "file")) {
    const destination = join(projectDir, ...file.metadata.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(file.bytes));
  }
  for (const file of verified.files.filter((entry) => entry.metadata.type === "symlink")) {
    const destination = join(projectDir, ...file.metadata.path.split("/"));
    const target = join(projectDir, ...String(file.metadata.target).split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await symlink(relative(dirname(destination), target), destination);
  }

  await writeFile(join(controlDir, "system.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const skill = await findCanonicalOpenShipSkill();
  await cp(skill, join(controlDir, "skills", "openship"), { recursive: true, force: true });
}

async function listProjectPaths(projectDir: string, current = ""): Promise<string[]> {
  const directory = current ? join(projectDir, ...current.split("/")) : projectDir;
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if ([".git", "node_modules", ".next", "dist", "build", "coverage"].includes(entry.name)) continue;
      paths.push(...await listProjectPaths(projectDir, path));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      paths.push(path);
    }
  }
  return paths.sort(compareUtf8);
}

async function snapshotOpenShipV1Project(
  projectDir: string,
  base: { manifest: SourcesManifest; bundle: SourcesBundle },
): Promise<{ manifest: SourcesManifest; bundle: SourcesBundle; verified: VerifiedSources }> {
  const baseFiles = new Map(base.manifest.files.map((file) => [file.path, file]));
  const metadata: SourceFileMetadata[] = [];
  const bundleFiles: SourcesBundle["files"] = {};
  for (const path of await listProjectPaths(projectDir)) {
    const absolutePath = join(projectDir, ...path.split("/"));
    const fileStat = await lstat(absolutePath);
    const bytes = new Uint8Array(await readFile(absolutePath));
    const previous = baseFiles.get(path);
    const text = isUtf8Source(bytes);
    const encoding = text ? "utf-8" : "base64";
    let target: string | undefined;
    if (fileStat.isSymbolicLink()) {
      const rawTarget = await readlink(absolutePath);
      const resolvedTarget = resolve(dirname(absolutePath), rawTarget);
      target = relative(projectDir, resolvedTarget).split("\\").join("/");
    }
    metadata.push({
      ...(previous ?? {}),
      path,
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
      encoding,
      mediaType: previous?.mediaType ?? mediaTypeForPath(path, text),
      type: fileStat.isSymbolicLink() ? "symlink" : "file",
      ...(target ? { target } : {}),
    });
    bundleFiles[path] = {
      encoding,
      content: encoding === "base64" ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes),
    };
  }
  const digest = computeSourcesDigest(metadata);
  const manifest = {
    ...base.manifest,
    digest,
    ...(digest !== base.manifest.digest ? { parent: base.manifest.digest } : {}),
    totals: { files: metadata.length, bytes: metadata.reduce((total, file) => total + file.size, 0) },
    files: metadata,
  } as SourcesManifest;
  const bundle = {
    ...base.bundle,
    digest,
    files: bundleFiles,
  } as SourcesBundle;
  return { manifest, bundle, verified: validateSources(manifest, bundle) };
}

function sourcePlanChanges(before: VerifiedSources, after: VerifiedSources): AgentRunPlanChange[] {
  const beforeByPath = new Map(before.files.map((file) => [file.metadata.path, file.metadata]));
  const afterByPath = new Map(after.files.map((file) => [file.metadata.path, file.metadata]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort(compareUtf8);
  return paths.flatMap((path) => {
    const previous = beforeByPath.get(path) ?? null;
    const current = afterByPath.get(path) ?? null;
    if (JSON.stringify(previous) === JSON.stringify(current)) return [];
    return [{
      target_table: "source_files",
      operation: previous ? (current ? "Update" : "Delete") : "Create",
      target_id: { path },
      previous: previous as Record<string, unknown> | null,
      current: current as Record<string, unknown> | null,
    } satisfies AgentRunPlanChange];
  });
}

async function runOpenShipV1AgentWithWorkspace(
  runPrompt: string,
  systemPrompt: string | null,
  workspace: string,
  threadId: string,
  model: string | undefined,
): Promise<RunClaudeAgentResult> {
  const systemIdResult = await query<{ system_id: string; spec_version: string }>(
    `SELECT s.id AS system_id,s.spec_version FROM systems s WHERE s.id=thread_current_system($1)`,
    [threadId],
  );
  if (systemIdResult.rows[0]?.spec_version !== "1.0") {
    throw new Error("legacy_openship_project: re-import this project to run an agent with OpenShip 1.0.");
  }
  const original = await exportSystems(pool, systemIdResult.rows[0].system_id);
  const originalVerified = validateSources(original.source.manifest, original.source.bundle);
  await materializeOpenShipV1Workspace(workspace, original, originalVerified);

  const instructions = [
    "This is an OpenShip 1.0 workspace.",
    "Edit source files only under project/.",
    "Edit architecture and context only in control/system.json.",
    "Do not edit control/skills/openship; it is the canonical protocol skill.",
    "The server will rebuild the Sources snapshot from project/ and will only accept the system portion of control/system.json.",
  ].join("\n");
  let result: AgentRunResult;
  try {
    result = await runAgent({
      prompt: `${instructions}\n\nUser request:\n${runPrompt}`,
      cwd: workspace,
      model,
      systemPrompt: [systemPrompt, instructions].filter(Boolean).join("\n\n"),
      allowedTools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write"],
    });
  } catch (error) {
    const message = runSummaryError(error);
    return { status: "failed", messages: [`Execution failed: ${message}`], changes: [], error: message, openShipBundleFiles: [] };
  }
  if (result.status === "failed") return { ...result, openShipBundleFiles: [] };

  try {
    const rebuilt = await snapshotOpenShipV1Project(join(workspace, "project"), original.source);
    const edited = JSON.parse(await readFile(join(workspace, "control", "system.json"), "utf8")) as SystemsDocument;
    const candidate = validateSystems({
      openship: "1.0",
      capability: "systems",
      source: { manifest: rebuilt.manifest, bundle: rebuilt.bundle },
      system: edited.system,
    });
    const sourceChanged = rebuilt.manifest.digest !== original.source.manifest.digest;
    const systemChanged = JSON.stringify(candidate.system) !== JSON.stringify(original.system);
    if (!sourceChanged && !systemChanged) {
      return { ...result, messages: [...result.messages, "OpenShip workspace: no changes."], changes: [], openShipBundleFiles: [] };
    }
    await applyOpenShipV1DocumentToThread(threadId, candidate);
    const changes = sourcePlanChanges(originalVerified, rebuilt.verified);
    if (systemChanged) {
      changes.push({
        target_table: "systems",
        operation: "Update",
        target_id: { threadId },
        previous: original.system,
        current: candidate.system,
      });
    }
    return {
      ...result,
      messages: [...result.messages, `OpenShip workspace reconciled (${changes.length} change${changes.length === 1 ? "" : "s"}).`],
      changes,
      openShipBundleFiles: [],
    };
  } catch (error) {
    const message = runSummaryError(error);
    return {
      status: "failed",
      messages: [...result.messages, `OpenShip 1.0 reconciliation failed: ${message}`],
      changes: result.changes,
      error: message,
      openShipBundleFiles: [],
    };
  }
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
  return runOpenShipV1AgentWithWorkspace(runPrompt, systemPrompt, workspace, threadId, model);
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
