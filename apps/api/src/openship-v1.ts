import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  computeSourcesDigest,
  validateSources,
  validateSystems,
  type DiscoveryDocument,
  type SourcesBundle,
  type SourcesManifest,
  type SystemsDocument,
  type VerifiedSources,
} from "@openshipdev/protocol";
import pool from "./db.js";

export const OPENSHIP_V1 = "1.0";
export const OPENSHIP_ROOT_NODE_ID = "s.root";
export const SYSTEM_PROMPT_CONCERN = "__system_prompt__";
export const MAX_OPENSHIP_SOURCE_BYTES = 64 * 1024 * 1024;

const BASELINE_CONCERNS = new Set([
  "Features", "General Specs", "General Skills", "Data Model", "Interfaces",
  "Connectivity", "Security", "Implementation", "Deployment",
]);

type JsonRecord = Record<string, unknown>;
type DbClient = Pick<PoolClient, "query">;
const asRecord = (value: unknown): JsonRecord => value as JsonRecord;

function without(value: JsonRecord, keys: string[]): JsonRecord {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

export function emptySources(project: { name: string; description: string }): { manifest: SourcesManifest; bundle: SourcesBundle } {
  const files: SourcesManifest["files"] = [];
  const digest = computeSourcesDigest(files);
  return {
    manifest: {
      openship: "1.0",
      capability: "sources",
      digest,
      project,
      totals: { files: 0, bytes: 0 },
      files,
    },
    bundle: { openship: "1.0", capability: "sources", digest, files: {} },
  };
}

export function verifyImportSnapshot(snapshot: unknown): {
  kind: "sources" | "systems";
  verified: VerifiedSources;
  systems: SystemsDocument | null;
} {
  const input = asRecord(snapshot);
  if (input.kind === "systems") {
    const systems = validateSystems(input.document, { maxDecodedBytes: MAX_OPENSHIP_SOURCE_BYTES });
    return {
      kind: "systems",
      systems,
      verified: validateSources(systems.source.manifest, systems.source.bundle, { maxDecodedBytes: MAX_OPENSHIP_SOURCE_BYTES }),
    };
  }
  if (input.kind === "sources") {
    return {
      kind: "sources",
      systems: null,
      verified: validateSources(input.manifest, input.bundle, { maxDecodedBytes: MAX_OPENSHIP_SOURCE_BYTES }),
    };
  }
  throw new Error("snapshot.kind must be sources or systems");
}

export async function persistSources(client: DbClient, verified: VerifiedSources): Promise<void> {
  const { manifest, bundle } = verified;
  await client.query(
    `INSERT INTO source_snapshots (digest, manifest, bundle_extensions, total_files, total_bytes)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5)
     ON CONFLICT (digest) DO NOTHING`,
    [
      manifest.digest,
      JSON.stringify(manifest),
      JSON.stringify(without(asRecord(bundle), ["openship", "capability", "digest", "files"])),
      manifest.totals.files,
      manifest.totals.bytes,
    ],
  );

  for (const { metadata, bytes } of verified.files) {
    await client.query(
      `INSERT INTO source_files (
         snapshot_digest, path, size, sha256, encoding, media_type, file_type, target, content, extensions
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (snapshot_digest, path) DO NOTHING`,
      [
        manifest.digest,
        metadata.path,
        metadata.size,
        metadata.sha256,
        metadata.encoding,
        metadata.mediaType,
        metadata.type,
        metadata.target ?? null,
        Buffer.from(bytes),
        JSON.stringify(without(asRecord(metadata), ["path", "size", "sha256", "encoding", "mediaType", "type", "target"])),
      ],
    );
  }
}

export async function populateOpenShipSystem(
  client: PoolClient,
  input: {
    systemId: string;
    fallbackName: string;
    origin: string | null;
    discovery: DiscoveryDocument | null;
    verified: VerifiedSources;
    systems: SystemsDocument | null;
    upstreamBaseDigest?: string | null;
    replaceExisting?: boolean;
  },
): Promise<void> {
  const { systemId, verified, systems } = input;
  await persistSources(client, verified);
  const model = systems?.system as JsonRecord | undefined;
  const rootNodeId = systems ? String(model?.rootNodeId) : OPENSHIP_ROOT_NODE_ID;
  const systemName = systems ? String(model?.name) : input.fallbackName;

  const systemMetadata = JSON.stringify(systems ? without(model ?? {}, ["id", "name", "rootNodeId", "nodes", "edges", "context"]) : {});
  if (input.replaceExisting) {
    await client.query("DELETE FROM artifact_source_paths WHERE system_id=$1", [systemId]);
    await client.query("DELETE FROM node_source_selectors WHERE system_id=$1", [systemId]);
    await client.query("DELETE FROM matrix_refs WHERE system_id=$1", [systemId]);
    await client.query("DELETE FROM artifacts WHERE system_id=$1", [systemId]);
    await client.query("DELETE FROM edges WHERE system_id=$1", [systemId]);
    await client.query("DELETE FROM documents WHERE system_id=$1", [systemId]);
    await client.query("DELETE FROM concerns WHERE system_id=$1", [systemId]);
    await client.query("DELETE FROM nodes WHERE system_id=$1", [systemId]);
    await client.query("DELETE FROM system_sources WHERE system_id=$1", [systemId]);
    await client.query(
      `UPDATE systems SET name=$1,spec_version='1.0',root_node_id=$2,metadata=$3::jsonb,updated_at=now()
       WHERE id=$4`,
      [systemName, rootNodeId, systemMetadata, systemId],
    );
  } else {
    await client.query(
      `INSERT INTO systems (id, name, spec_version, root_node_id, metadata)
       VALUES ($1,$2,'1.0',$3,$4::jsonb)`,
      [systemId, systemName, rootNodeId, systemMetadata],
    );
  }

  const nodes = systems ? (model?.nodes as JsonRecord[]) : [{ id: rootNodeId, kind: "Root", name: systemName }];
  for (const node of nodes) {
    await client.query(
      `INSERT INTO nodes (id, system_id, kind, name, parent_id, metadata)
       VALUES ($1,$2,$3::node_kind,$4,$5,$6::jsonb)`,
      [node.id, systemId, node.kind, node.name, node.parentId ?? null, JSON.stringify(node.metadata ?? {})],
    );
    for (const [position, selector] of ((node.sourceSelectors as string[] | undefined) ?? []).entries()) {
      await client.query(
        `INSERT INTO node_source_selectors (system_id, node_id, selector, position) VALUES ($1,$2,$3,$4)`,
        [systemId, node.id, selector, position],
      );
    }
  }

  const context = (model?.context as JsonRecord | undefined) ?? null;
  for (const [position, concern] of ((context?.concerns as string[] | undefined) ?? []).entries()) {
    await client.query(
      `INSERT INTO concerns (system_id, name, position, is_baseline) VALUES ($1,$2,$3,$4)`,
      [systemId, concern, position, BASELINE_CONCERNS.has(concern)],
    );
  }

  const promptRefs = (context?.systemPromptRefs as string[] | undefined) ?? [];
  if (promptRefs.length > 0) {
    await client.query(
      `INSERT INTO concerns (system_id, name, position, is_baseline, scope)
       VALUES ($1,$2,2147483647,false,'system') ON CONFLICT DO NOTHING`,
      [systemId, SYSTEM_PROMPT_CONCERN],
    );
  }

  for (const document of ((context?.documents as JsonRecord[] | undefined) ?? [])) {
    await client.query(
      `INSERT INTO documents (hash, system_id, kind, title, language, source_type, text, supersedes)
       VALUES ($1,$2,$3::doc_kind,$4,$5,'local',$6,$7)`,
      [document.hash, systemId, document.kind, document.title, document.language, document.text, document.supersedes ?? null],
    );
  }

  for (const cell of ((context?.matrix as JsonRecord[] | undefined) ?? [])) {
    for (const hash of ((cell.documentRefs as string[] | undefined) ?? [])) {
      await client.query(
        `INSERT INTO matrix_refs (system_id,node_id,concern,ref_type,doc_hash) VALUES ($1,$2,$3,'Document',$4)`,
        [systemId, cell.nodeId, cell.concern, hash],
      );
    }
    for (const hash of ((cell.skillRefs as string[] | undefined) ?? [])) {
      await client.query(
        `INSERT INTO matrix_refs (system_id,node_id,concern,ref_type,doc_hash) VALUES ($1,$2,$3,'Skill',$4)`,
        [systemId, cell.nodeId, cell.concern, hash],
      );
    }
  }
  for (const hash of promptRefs) {
    await client.query(
      `INSERT INTO matrix_refs (system_id,node_id,concern,ref_type,doc_hash) VALUES ($1,$2,$3,'Prompt',$4)`,
      [systemId, rootNodeId, SYSTEM_PROMPT_CONCERN, hash],
    );
  }

  for (const artifact of ((context?.artifacts as JsonRecord[] | undefined) ?? [])) {
    await client.query(
      `INSERT INTO artifacts (id,system_id,node_id,concern,type,language,text)
       VALUES ($1,$2,$3,$4,$5::artifact_type,$6,$7)`,
      [artifact.id, systemId, artifact.nodeId, artifact.concern, artifact.type, artifact.language ?? "en", artifact.text ?? null],
    );
    for (const [position, sourcePath] of ((artifact.sourcePaths as string[] | undefined) ?? []).entries()) {
      await client.query(
        `INSERT INTO artifact_source_paths (system_id,artifact_id,snapshot_digest,source_path,position)
         VALUES ($1,$2,$3,$4,$5)`,
        [systemId, artifact.id, verified.manifest.digest, sourcePath, position],
      );
    }
  }

  for (const edge of ((model?.edges as JsonRecord[] | undefined) ?? [])) {
    await client.query(
      `INSERT INTO edges (id,system_id,type,from_node_id,to_node_id,metadata)
       VALUES ($1,$2,$3::edge_type,$4,$5,$6::jsonb)`,
      [edge.id, systemId, edge.type, edge.fromNodeId, edge.toNodeId, JSON.stringify(edge.metadata ?? {})],
    );
  }

  await client.query(
    `INSERT INTO system_sources (
       system_id,current_digest,upstream_base_digest,origin,discovery,original_system
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [
      systemId,
      verified.manifest.digest,
      input.upstreamBaseDigest ?? verified.manifest.digest,
      input.origin,
      input.discovery ? JSON.stringify(input.discovery) : null,
      systems ? JSON.stringify(systems) : null,
    ],
  );
}

export async function applyOpenShipV1DocumentToThread(
  threadId: string,
  inputDocument: unknown,
  title = "Apply OpenShip 1.0 workspace changes",
): Promise<{ actionId: string; systemId: string; digest: string }> {
  const document = validateSystems(inputDocument, { maxDecodedBytes: MAX_OPENSHIP_SOURCE_BYTES });
  const verified = validateSources(document.source.manifest, document.source.bundle, {
    maxDecodedBytes: MAX_OPENSHIP_SOURCE_BYTES,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const provenance = await client.query<{
      current_digest: string;
      upstream_base_digest: string | null;
      origin: string | null;
      discovery: DiscoveryDocument | null;
    }>(
      `SELECT ss.current_digest,ss.upstream_base_digest,ss.origin,ss.discovery
       FROM system_sources ss WHERE ss.system_id=thread_current_system($1)`,
      [threadId],
    );
    const base = provenance.rows[0];
    if (!base) throw new Error("The thread is not attached to an OpenShip 1.0 system.");
    const actionId = randomUUID();
    const action = await client.query<{ output_system_id: string }>(
      `SELECT begin_action($1,$2,'Update'::action_type,$3) AS output_system_id`,
      [threadId, actionId, title],
    );
    const systemId = action.rows[0]?.output_system_id;
    if (!systemId) throw new Error("Unable to create the OpenShip update fork.");
    await populateOpenShipSystem(client, {
      systemId,
      fallbackName: String(document.system.name),
      origin: base.origin,
      discovery: base.discovery,
      verified,
      systems: document,
      upstreamBaseDigest: base.upstream_base_digest ?? base.current_digest,
      replaceExisting: true,
    });
    await client.query("COMMIT");
    return { actionId, systemId, digest: verified.manifest.digest };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type SourceFileRow = {
  path: string; size: string | number; sha256: string; encoding: "utf-8" | "base64";
  media_type: string; file_type: "file" | "symlink"; target: string | null; content: Buffer; extensions: JsonRecord;
};

export async function exportSources(client: DbClient, systemId: string): Promise<{ manifest: SourcesManifest; bundle: SourcesBundle }> {
  const sourceResult = await client.query<{ current_digest: string; manifest: SourcesManifest; bundle_extensions: JsonRecord }>(
    `SELECT ss.current_digest, snap.manifest, snap.bundle_extensions
     FROM system_sources ss JOIN source_snapshots snap ON snap.digest = ss.current_digest
     WHERE ss.system_id = $1`,
    [systemId],
  );
  const source = sourceResult.rows[0];
  if (!source) throw new Error("This system has no OpenShip 1.0 Sources snapshot.");
  return exportSourcesDigest(client, source.current_digest, source.manifest, source.bundle_extensions);
}

export async function exportSourcesDigest(
  client: DbClient,
  digest: string,
  knownManifest?: SourcesManifest,
  knownBundleExtensions?: JsonRecord,
): Promise<{ manifest: SourcesManifest; bundle: SourcesBundle }> {
  let manifest = knownManifest;
  let bundleExtensions = knownBundleExtensions;
  if (!manifest || !bundleExtensions) {
    const snapshot = await client.query<{ manifest: SourcesManifest; bundle_extensions: JsonRecord }>(
      "SELECT manifest,bundle_extensions FROM source_snapshots WHERE digest=$1",
      [digest],
    );
    if (!snapshot.rows[0]) throw new Error(`OpenShip source snapshot ${digest} is unavailable.`);
    manifest = snapshot.rows[0].manifest;
    bundleExtensions = snapshot.rows[0].bundle_extensions;
  }
  const rows = await client.query<SourceFileRow>(
    `SELECT path,size,sha256,encoding,media_type,file_type,target,content,extensions
     FROM source_files WHERE snapshot_digest = $1 ORDER BY path COLLATE "C"`,
    [digest],
  );
  const files = Object.fromEntries(rows.rows.map((row) => [row.path, {
    encoding: row.encoding,
    content: row.encoding === "base64" ? row.content.toString("base64") : row.content.toString("utf8"),
  }]));
  return {
    manifest,
    bundle: { ...bundleExtensions, openship: "1.0", capability: "sources", digest, files } as SourcesBundle,
  };
}

export async function exportSystems(client: DbClient, systemId: string): Promise<SystemsDocument> {
  const source = await exportSources(client, systemId);
  const systemResult = await client.query<{ id: string; name: string; root_node_id: string; metadata: JsonRecord; original_system: SystemsDocument | null }>(
    `SELECT s.id,s.name,s.root_node_id,s.metadata,ss.original_system
     FROM systems s LEFT JOIN system_sources ss ON ss.system_id=s.id
     WHERE s.id=$1 AND s.spec_version='1.0'`, [systemId],
  );
  const system = systemResult.rows[0];
  if (!system) throw new Error("Legacy OpenShip projects cannot be exported as 1.0.");
  const [nodes, edges, concerns, documents, matrix, prompts, artifacts] = await Promise.all([
    client.query(`SELECT n.id,n.kind::text,n.name,n.parent_id,n.metadata,
      COALESCE(jsonb_agg(ns.selector ORDER BY ns.position) FILTER (WHERE ns.selector IS NOT NULL),'[]') selectors
      FROM nodes n LEFT JOIN node_source_selectors ns ON ns.system_id=n.system_id AND ns.node_id=n.id
      WHERE n.system_id=$1 GROUP BY n.system_id,n.id ORDER BY n.id`, [systemId]),
    client.query(`SELECT id,type::text,from_node_id,to_node_id,metadata FROM edges WHERE system_id=$1 ORDER BY id`, [systemId]),
    client.query(`SELECT name FROM concerns WHERE system_id=$1 AND name<>$2 ORDER BY position,name`, [systemId, SYSTEM_PROMPT_CONCERN]),
    client.query(`SELECT hash,kind::text,title,language,text,supersedes FROM documents WHERE system_id=$1 ORDER BY hash`, [systemId]),
    client.query(`SELECT node_id,concern,ref_type::text,doc_hash FROM matrix_refs WHERE system_id=$1 AND ref_type<>'Prompt' ORDER BY node_id,concern,ref_type,doc_hash`, [systemId]),
    client.query(`SELECT doc_hash FROM matrix_refs WHERE system_id=$1 AND ref_type='Prompt' ORDER BY doc_hash`, [systemId]),
    client.query(`SELECT a.id,a.node_id,a.concern,a.type::text,a.language,a.text,
      COALESCE(jsonb_agg(asp.source_path ORDER BY asp.position) FILTER (WHERE asp.source_path IS NOT NULL),'[]') source_paths
      FROM artifacts a LEFT JOIN artifact_source_paths asp ON asp.system_id=a.system_id AND asp.artifact_id=a.id
      WHERE a.system_id=$1 GROUP BY a.system_id,a.id ORDER BY a.id`, [systemId]),
  ]);
  const cells = new Map<string, JsonRecord>();
  for (const row of matrix.rows as Array<{ node_id: string; concern: string; ref_type: string; doc_hash: string }>) {
    const key = `${row.node_id}\0${row.concern}`;
    const cell = cells.get(key) ?? { nodeId: row.node_id, concern: row.concern, documentRefs: [], skillRefs: [] };
    (cell[row.ref_type === "Document" ? "documentRefs" : "skillRefs"] as string[]).push(row.doc_hash);
    cells.set(key, cell);
  }
  const originalDocument = system.original_system as SystemsDocument | null;
  const originalModel = (originalDocument?.system ?? {}) as JsonRecord;
  const originalContext = (originalModel.context ?? {}) as JsonRecord;
  const mergeBy = (known: JsonRecord[], original: unknown, key: (value: JsonRecord) => string) => {
    const originals = new Map((Array.isArray(original) ? original : []).map((value) => [key(value as JsonRecord), value as JsonRecord]));
    return known.map((value) => ({ ...(originals.get(key(value)) ?? {}), ...value }));
  };
  const context = {
    ...originalContext,
    concerns: concerns.rows.map((row: { name: string }) => row.name),
    documents: mergeBy(documents.rows.map((row: any) => ({ kind: row.kind, hash: row.hash, title: row.title, language: row.language, text: row.text, ...(row.supersedes ? { supersedes: row.supersedes } : {}) })), originalContext.documents, (value) => String(value.hash)),
    matrix: mergeBy([...cells.values()], originalContext.matrix, (value) => `${String(value.nodeId)}\0${String(value.concern)}`),
    systemPromptRefs: prompts.rows.map((row: { doc_hash: string }) => row.doc_hash),
    artifacts: mergeBy(artifacts.rows.map((row: any) => ({ id: row.id, nodeId: row.node_id, concern: row.concern, type: row.type, ...(row.language ? { language: row.language } : {}), ...(row.type === "Code" ? { sourcePaths: row.source_paths } : { text: row.text }) })), originalContext.artifacts, (value) => String(value.id)),
  };
  const knownNodes = nodes.rows.map((row: any) => ({ id: row.id, kind: row.kind, name: row.name, ...(row.parent_id ? { parentId: row.parent_id } : {}), ...(row.selectors.length ? { sourceSelectors: row.selectors } : {}), ...(Object.keys(row.metadata ?? {}).length ? { metadata: row.metadata } : {}) }));
  const knownEdges = edges.rows.map((row: any) => ({ id: row.id, type: row.type, fromNodeId: row.from_node_id, toNodeId: row.to_node_id, ...(Object.keys(row.metadata ?? {}).length ? { metadata: row.metadata } : {}) }));
  const document = {
    ...(originalDocument ?? {}),
    openship: "1.0",
    capability: "systems",
    source,
    system: {
      ...originalModel,
      ...system.metadata,
      id: system.id,
      name: system.name,
      rootNodeId: system.root_node_id,
      nodes: mergeBy(knownNodes, originalModel.nodes, (value) => String(value.id)),
      edges: mergeBy(knownEdges, originalModel.edges, (value) => String(value.id)),
      ...(context.concerns.length || context.documents.length || context.artifacts.length ? { context } : {}),
    },
  } as SystemsDocument;
  validateSystems(document, { maxDecodedBytes: MAX_OPENSHIP_SOURCE_BYTES });
  return document;
}
