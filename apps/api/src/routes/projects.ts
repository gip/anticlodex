import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { verifyAuth, verifyOptionalAuth, type AuthUser } from "../auth.js";
import pool, { query } from "../db.js";
import {
  applyOpenShipBundleToThreadSystemWithClient,
  collectOpenShipBundleFiles,
  type OpenShipBundleFile,
} from "../openship-sync.js";
import {
  BLANK_TEMPLATE_ID,
  DEFAULT_CONCERNS,
  getTemplateById,
  isKnownTemplateId,
  type TemplateDefinition,
  type TemplateDocument,
} from "../templates/index.js";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  access_role: string;
  visibility: ProjectVisibility;
  created_at: Date;
}

interface ThreadRow {
  id: string;
  title: string | null;
  description: string | null;
  project_thread_id: number | null;
  status: string;
  source_thread_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

type AccessRole = "Owner" | "Editor" | "Viewer";
type ProjectVisibility = "public" | "private";
type OpenShipNodeKind = "Root" | "Host" | "Container" | "Process" | "Library";

const OPENSHIP_ROOT_NODE_ID = "s.root";
const TYPED_NODE_ID_SCHEME = "typed_key_v1";
const OPENSHIP_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function kindToPrefix(kind: OpenShipNodeKind): string {
  if (kind === "Root") return "s";
  if (kind === "Host") return "h";
  if (kind === "Container") return "c";
  if (kind === "Process") return "p";
  return "l";
}

function normalizeOpenShipKey(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!OPENSHIP_KEY_PATTERN.test(normalized)) {
    throw new Error(`Invalid OpenShip key "${raw}".`);
  }
  return normalized;
}

function buildTypedNodeId(kind: OpenShipNodeKind, key: string): string {
  if (kind === "Root") return OPENSHIP_ROOT_NODE_ID;
  return `${kindToPrefix(kind)}.${key}`;
}

function computeDocumentHash(document: Pick<TemplateDocument, "kind" | "title" | "language" | "text">) {
  const payload = [document.kind, document.title, document.language, document.text].join("\n");
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function resolveTemplateBundlePath(bundlePath: string): string {
  const override = process.env.STAFFX_TEMPLATE_BUNDLE_PATH?.trim();
  if (override) return resolve(override);

  const direct = resolve(process.cwd(), bundlePath);
  const workspaceRoot = resolve(process.cwd(), "..", "..", bundlePath);
  if (existsSync(direct)) return direct;
  if (existsSync(workspaceRoot)) return workspaceRoot;
  return direct;
}

async function seedSystemConcerns(
  client: PoolClient,
  systemId: string,
  concerns: Array<{ name: string; position: number; isBaseline: boolean; scope?: string | null }>,
) {
  for (const concern of concerns) {
    await client.query(
      `INSERT INTO concerns (system_id, name, position, is_baseline, scope)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (system_id, name) DO NOTHING`,
      [systemId, concern.name, concern.position, concern.isBaseline, concern.scope ?? null],
    );
  }
}

async function seedSystemTemplate(
  client: PoolClient,
  systemId: string,
  rootNodeId: string,
  template: TemplateDefinition,
) {
  const nodeIds = new Map<string, string>([["root", rootNodeId]]);
  const nodeOpenShipKeys = new Map<string, string>();
  const nodeIdToTemplateKey = new Map<string, string>();
  for (const node of template.nodes) {
    if (nodeIds.has(node.key)) {
      throw new Error(`Template "${template.id}" has duplicate node key "${node.key}"`);
    }
    const openShipKey = normalizeOpenShipKey(node.key);
    const typedNodeId = buildTypedNodeId(node.kind, openShipKey);
    const existingTemplateKey = nodeIdToTemplateKey.get(typedNodeId);
    if (existingTemplateKey) {
      throw new Error(
        `Template "${template.id}" has node id collision after normalization: ` +
        `"${existingTemplateKey}" and "${node.key}" both map to "${typedNodeId}"`,
      );
    }
    nodeIds.set(node.key, typedNodeId);
    nodeOpenShipKeys.set(node.key, openShipKey);
    nodeIdToTemplateKey.set(typedNodeId, node.key);
  }

  for (const node of template.nodes) {
    const nodeId = nodeIds.get(node.key);
    const openShipKey = nodeOpenShipKeys.get(node.key);
    const parentKey = node.parentKey ?? "root";
    const parentNodeId = nodeIds.get(parentKey);
    if (!nodeId || !parentNodeId || !openShipKey) {
      throw new Error(
        `Template "${template.id}" references unknown parent "${parentKey}" for node "${node.key}"`,
      );
    }

    const nodeMetadata = {
      ...node.metadata,
      ...(node.layout ? { layout: node.layout } : {}),
      openshipKey: openShipKey,
    };

    await client.query(
      `INSERT INTO nodes (id, system_id, kind, name, parent_id, metadata)
       VALUES ($1, $2, $3::node_kind, $4, $5, $6::jsonb)`,
      [
        nodeId,
        systemId,
        node.kind,
        node.name,
        parentNodeId,
        JSON.stringify(nodeMetadata),
      ],
    );
  }

  for (const edge of template.edges) {
    const fromNodeId = nodeIds.get(edge.fromKey);
    const toNodeId = nodeIds.get(edge.toKey);
    if (!fromNodeId || !toNodeId) {
      throw new Error(
        `Template "${template.id}" edge references unknown nodes "${edge.fromKey}" -> "${edge.toKey}"`,
      );
    }

    const metadata = edge.protocol ? JSON.stringify({ protocol: edge.protocol }) : "{}";
    await client.query(
      `INSERT INTO edges (id, system_id, type, from_node_id, to_node_id, metadata)
       VALUES ($1, $2, $3::edge_type, $4, $5, $6::jsonb)`,
      [randomUUID(), systemId, edge.type, fromNodeId, toNodeId, metadata],
    );
  }

  await seedSystemConcerns(client, systemId, template.concerns);
  const concernNames = new Set(template.concerns.map((concern) => concern.name));

  const documentHashes = new Map<string, string>();
  for (const document of template.documents) {
    if (documentHashes.has(document.key)) {
      throw new Error(`Template "${template.id}" has duplicate document key "${document.key}"`);
    }
    const hash = computeDocumentHash(document);
    documentHashes.set(document.key, hash);

    await client.query(
      `INSERT INTO documents (hash, system_id, kind, title, language, text)
       VALUES ($1, $2, $3::doc_kind, $4, $5, $6)
       ON CONFLICT (system_id, hash) DO NOTHING`,
      [hash, systemId, document.kind, document.title, document.language, document.text],
    );
  }

  for (const ref of template.matrixRefs) {
    const nodeId = nodeIds.get(ref.nodeKey);
    const docHash = documentHashes.get(ref.documentKey);
    if (!nodeId) {
      throw new Error(`Template "${template.id}" matrix ref references unknown node "${ref.nodeKey}"`);
    }
    if (!docHash) {
      throw new Error(
        `Template "${template.id}" matrix ref references unknown document "${ref.documentKey}"`,
      );
    }
    if (!concernNames.has(ref.concern)) {
      throw new Error(`Template "${template.id}" matrix ref references unknown concern "${ref.concern}"`);
    }

    await client.query(
      `INSERT INTO matrix_refs (system_id, node_id, concern, ref_type, doc_hash)
       VALUES ($1, $2, $3, $4::ref_type, $5)
       ON CONFLICT DO NOTHING`,
      [systemId, nodeId, ref.concern, ref.refType, docHash],
    );
  }
}

interface ResolvedProject {
  projectId: string;
  accessRole: AccessRole;
  ownerId: string;
  visibility: ProjectVisibility;
}

interface ProjectAccessRow {
  id: string;
  owner_id: string;
  visibility: ProjectVisibility;
  collaborator_role: AccessRole | null;
  is_archived: boolean;
}

function getAuthUser(req: FastifyRequest): AuthUser | null {
  return (req as FastifyRequest & { auth?: AuthUser }).auth ?? null;
}

async function requireAuthUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  await verifyAuth(req, reply);
  if (reply.sent) return null;
  return getAuthUser(req);
}

async function getOptionalViewerUserId(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null | undefined> {
  await verifyOptionalAuth(req, reply);
  if (reply.sent) return undefined;
  return getAuthUser(req)?.id ?? null;
}

function resolveAccessRole(
  ownerId: string,
  viewerUserId: string | null,
  visibility: ProjectVisibility,
  collaboratorRole: AccessRole | null,
): AccessRole | null {
  if (viewerUserId && ownerId === viewerUserId) return "Owner";
  if (collaboratorRole === "Editor" || collaboratorRole === "Viewer") return collaboratorRole;
  if (visibility === "public") return "Viewer";
  return null;
}

async function resolveProject(
  handle: string,
  projectName: string,
  viewerUserId: string | null,
): Promise<ResolvedProject | null> {
  const normalizedHandle = handle.trim();
  const result = await query<ProjectAccessRow>(
      `SELECT
       p.id,
        p.owner_id,
        p.visibility::text AS visibility,
        pc.role::text AS collaborator_role,
        p.is_archived
      FROM projects p
      JOIN users owner ON owner.id = p.owner_id
      LEFT JOIN project_collaborators pc
      ON pc.project_id = p.id
       AND pc.user_id = CAST($3 AS uuid)
     WHERE lower(owner.handle) = lower($1)
       AND p.name = $2
       AND p.is_archived = false
      LIMIT 1`,
    [normalizedHandle, projectName, viewerUserId],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  const accessRole = resolveAccessRole(row.owner_id, viewerUserId, row.visibility, row.collaborator_role);
  if (!accessRole) return null;
  return { projectId: row.id, accessRole, ownerId: row.owner_id, visibility: row.visibility };
}

async function resolveProjectSystemId(projectId: string): Promise<string | null> {
  const result = await query<{ system_id: string }>(
    `SELECT thread_current_system(t.id) AS system_id
     FROM threads t
     WHERE t.project_id = $1
     ORDER BY t.project_thread_id ASC
     LIMIT 1`,
    [projectId],
  );
  return result.rows[0]?.system_id ?? null;
}

export async function projectRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { name: string } }>(
    "/projects/check-name",
    async (req, reply) => {
      const authUser = await requireAuthUser(req, reply);
      if (!authUser) return;

      const { name } = req.query;
      if (!name) return reply.code(400).send({ error: "name is required" });

      const result = await query(
        "SELECT 1 FROM projects WHERE owner_id = $1 AND name = $2",
        [authUser.id, name],
      );
      return { available: result.rowCount === 0 };
    },
  );

  app.get("/projects", async (req, reply) => {
    const viewerUserId = await getOptionalViewerUserId(req, reply);
    if (typeof viewerUserId === "undefined") return;

    const rows = viewerUserId
      ? (
        await query<ProjectRow & { owner_handle: string; threads: ThreadRow[] }>(
          `SELECT
             p.id,
             p.name,
             p.description,
             p.visibility::text AS visibility,
             CASE
               WHEN p.owner_id = $1 THEN 'Owner'
               WHEN pc.role IS NOT NULL THEN pc.role::text
               ELSE 'Viewer'
             END AS access_role,
             p.created_at,
             owner.handle AS owner_handle,
             COALESCE(
                (SELECT jsonb_agg(t)
                FROM (
                  SELECT t.id, t.title, t.description, t.project_thread_id, t.status, t.updated_at
                  FROM threads t
                  WHERE t.project_id = p.id
                  ORDER BY t.updated_at DESC
                  LIMIT 10
                ) t),
               '[]'::jsonb
             ) AS threads
           FROM projects p
           JOIN users owner ON owner.id = p.owner_id
           LEFT JOIN project_collaborators pc ON pc.project_id = p.id AND pc.user_id = $1
           WHERE (
             p.visibility = 'public'
             OR p.owner_id = $1
             OR pc.user_id IS NOT NULL
           )
           AND p.is_archived = false
           ORDER BY p.created_at DESC`,
          [viewerUserId],
        )
      ).rows
      : (
        await query<ProjectRow & { owner_handle: string; threads: ThreadRow[] }>(
          `SELECT
             p.id,
             p.name,
             p.description,
             p.visibility::text AS visibility,
             'Viewer' AS access_role,
             p.created_at,
             owner.handle AS owner_handle,
             COALESCE(
                (SELECT jsonb_agg(t)
                FROM (
                  SELECT t.id, t.title, t.description, t.project_thread_id, t.status, t.updated_at
                  FROM threads t
                  WHERE t.project_id = p.id
                  ORDER BY t.updated_at DESC
                  LIMIT 10
                ) t),
               '[]'::jsonb
             ) AS threads
           FROM projects p
           JOIN users owner ON owner.id = p.owner_id
           WHERE p.visibility = 'public'
             AND p.is_archived = false
           ORDER BY p.created_at DESC`,
        )
      ).rows;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      accessRole: row.access_role,
      visibility: row.visibility,
      ownerHandle: row.owner_handle,
      createdAt: row.created_at,
      threads: (row.threads as unknown as ThreadRow[]).map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        projectThreadId: t.project_thread_id,
        status: t.status,
        updatedAt: t.updated_at,
      })),
    }));
  });

  app.get<{ Params: { handle: string; projectName: string } }>(
    "/projects/:handle/:projectName",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const { handle, projectName } = req.params;
      const project = await resolveProject(handle, projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });

      const result = await query<Omit<ProjectRow, "access_role"> & { owner_handle: string; threads: ThreadRow[] }>(
        `SELECT
           p.id,
           p.name,
           p.description,
           p.visibility::text AS visibility,
           p.created_at,
           u.handle AS owner_handle,
           COALESCE(
              (SELECT jsonb_agg(t ORDER BY t.project_thread_id DESC)
              FROM (
                SELECT t.id, t.title, t.description, t.project_thread_id, t.status,
                       t.source_thread_id, t.created_by, t.created_at, t.updated_at
                FROM threads t
                WHERE t.project_id = p.id
              ) t),
             '[]'::jsonb
           ) AS threads
         FROM projects p
         JOIN users u ON u.id = p.owner_id
         WHERE p.id = $1`,
        [project.projectId],
      );

      if (result.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const row = result.rows[0];
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        accessRole: project.accessRole,
        visibility: row.visibility,
        ownerHandle: row.owner_handle,
        createdAt: row.created_at,
        threads: (row.threads as unknown as ThreadRow[]).map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          projectThreadId: t.project_thread_id,
          status: t.status,
          sourceThreadId: t.source_thread_id,
          createdBy: t.created_by,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        })),
      };
    },
  );

  app.post<{ Body: { name: string; description?: string; template?: string; visibility?: ProjectVisibility } }>(
    "/projects",
    async (req, reply) => {
      const authUser = await requireAuthUser(req, reply);
      if (!authUser) return;

      const { name, description, template, visibility } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        return reply.code(400).send({ error: "name is required" });
      }
      if (visibility !== "public" && visibility !== "private") {
        return reply.code(400).send({ error: "visibility must be public or private" });
      }

      const trimmed = name.trim();
      if (trimmed !== name) {
        return reply.code(400).send({ error: "name must not have leading or trailing spaces" });
      }
      if (!/^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(trimmed) || /[-_]{2}/.test(trimmed)) {
        return reply.code(400).send({ error: "name must start/end with a letter or number, no consecutive - or _" });
      }

      const selectedTemplateId = template ?? BLANK_TEMPLATE_ID;
      if (!isKnownTemplateId(selectedTemplateId)) {
        return reply.code(400).send({ error: "Invalid template" });
      }
      const selectedTemplate = getTemplateById(selectedTemplateId);
      let templateBundleFiles: OpenShipBundleFile[] | null = null;
      if (selectedTemplate?.bundleImportPath) {
        const bundlePath = resolveTemplateBundlePath(selectedTemplate.bundleImportPath);
        try {
          templateBundleFiles = await collectOpenShipBundleFiles(bundlePath);
        } catch (error) {
          req.log.error({ error, bundlePath, templateId: selectedTemplate.id }, "Failed to load template bundle");
          return reply.code(500).send({ error: "Template bundle unavailable" });
        }
      }

      const id = randomUUID();
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("BEGIN");
        inTransaction = true;

        const result = await client.query<ProjectRow>(
          `INSERT INTO projects (id, name, description, visibility, owner_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, description, visibility::text AS visibility, created_at`,
          [id, trimmed, description?.trim() || null, visibility, authUser.id],
        );

        const systemId = randomUUID();
        const rootNodeId = OPENSHIP_ROOT_NODE_ID;
        await client.query(
          `INSERT INTO systems (id, name, root_node_id, metadata)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [systemId, trimmed, rootNodeId, JSON.stringify({ nodeIdScheme: TYPED_NODE_ID_SCHEME })],
        );
        await client.query(
          `INSERT INTO nodes (id, system_id, kind, name, parent_id, metadata)
           VALUES ($1, $2, 'Root'::node_kind, $3, NULL, $4::jsonb)`,
          [
            rootNodeId,
            systemId,
            trimmed,
            JSON.stringify({
              openshipKey: "root",
              ownership: "first_party",
              boundary: "internal",
            }),
          ],
        );

        if (selectedTemplate) {
          await seedSystemTemplate(client, systemId, rootNodeId, selectedTemplate);
        } else {
          await seedSystemConcerns(
            client,
            systemId,
            DEFAULT_CONCERNS.map((concern) => ({
              ...concern,
              scope: null,
            })),
          );
        }

        const threadId = randomUUID();
        await client.query(
          "SELECT create_thread($1, $2, $3, $4, $5, $6)",
          [threadId, id, authUser.id, systemId, "Project Creation", null],
        );
        if (templateBundleFiles) {
          await applyOpenShipBundleToThreadSystemWithClient(client, {
            threadId,
            bundleFiles: templateBundleFiles,
          });
        }

        const threadResult = await client.query<ThreadRow>(
          `SELECT t.id, t.title, t.description, t.project_thread_id, t.status, t.updated_at
           FROM threads t
           WHERE t.id = $1`,
          [threadId],
        );
        const createdThreads = threadResult.rows;

        // Seed default project roles
        await client.query(
          `INSERT INTO project_roles (project_id, name, position) VALUES
           ($1, 'Product', 0), ($1, 'Implementation', 1), ($1, 'Quality', 2),
           ($1, 'Deployment', 3), ($1, 'All', 4)`,
          [id],
        );

        // Assign owner the "All" role
        await client.query(
          `INSERT INTO project_member_roles (project_id, user_id, role_name)
           VALUES ($1, $2, 'All')`,
          [id, authUser.id],
        );

        const row = result.rows[0];
        const handleResult = await client.query<{ handle: string }>(
          "SELECT handle FROM users WHERE id = $1",
          [authUser.id],
        );

        await client.query("COMMIT");
        inTransaction = false;

        return reply.code(201).send({
          id: row.id,
          name: row.name,
          description: row.description,
          accessRole: "Owner",
          visibility: row.visibility,
          ownerHandle: handleResult.rows[0].handle,
          createdAt: row.created_at,
          threads: createdThreads.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            projectThreadId: t.project_thread_id,
            status: t.status,
            updatedAt: t.updated_at,
          })),
        });
      } catch (err: unknown) {
        if (inTransaction) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Best effort rollback; preserve the original error.
          }
        }
        if (
          err instanceof Error &&
          "code" in err &&
          (err as { code: string }).code === "23505" &&
          "constraint" in err &&
          (err as { constraint?: string }).constraint === "idx_projects_owner_name"
        ) {
          return reply.code(409).send({ error: "A project with this name already exists" });
        }
        throw err;
      } finally {
        client.release();
      }
    },
  );

  app.patch<{
    Params: { handle: string; projectName: string };
    Body: { description?: string | null };
  }>(
    "/projects/:handle/:projectName/description",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.accessRole !== "Owner" && project.accessRole !== "Editor") {
        return reply.code(403).send({ error: "Only the owner or editors can update project description" });
      }
      if (typeof req.body?.description === "undefined") {
        return reply.code(400).send({ error: "description is required" });
      }
      if (req.body.description !== null && typeof req.body.description !== "string") {
        return reply.code(400).send({ error: "description must be a string or null" });
      }

      const nextDescription = req.body.description === null
        ? null
        : (req.body.description.trim() || null);
      const result = await query<{ description: string | null }>(
        `UPDATE projects
         SET description = $1
         WHERE id = $2
         RETURNING description`,
        [nextDescription, project.projectId],
      );
      if (result.rowCount === 0) return reply.code(404).send({ error: "Project not found" });

      return {
        description: result.rows[0].description,
      };
    },
  );

  app.patch<{
    Params: { handle: string; projectName: string };
    Body: { visibility?: ProjectVisibility };
  }>(
    "/projects/:handle/:projectName/visibility",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.accessRole !== "Owner") {
        return reply.code(403).send({ error: "Only the owner can update visibility" });
      }

      const nextVisibility = req.body?.visibility;
      if (nextVisibility !== "public" && nextVisibility !== "private") {
        return reply.code(400).send({ error: "visibility must be public or private" });
      }

      const result = await query<{ visibility: ProjectVisibility }>(
        `UPDATE projects
         SET visibility = $1::project_visibility
         WHERE id = $2
         RETURNING visibility::text AS visibility`,
        [nextVisibility, project.projectId],
      );
      if (result.rowCount === 0) return reply.code(404).send({ error: "Project not found" });

      return {
        visibility: result.rows[0].visibility,
      };
    },
  );

  app.post<{
    Params: { handle: string; projectName: string };
  }>("/projects/:handle/:projectName/archive", async (req, reply) => {
    const viewerUserId = await getOptionalViewerUserId(req, reply);
    if (typeof viewerUserId === "undefined") return;

    const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.accessRole !== "Owner") {
      return reply.code(403).send({ error: "Only the owner can archive this repo" });
    }

    await query(
      "UPDATE projects SET is_archived = true WHERE id = $1",
      [project.projectId],
    );

    return reply.code(204).send();
  });

  // ── Collaborators ────────────────────────────────────────────

  app.get<{ Params: { handle: string; projectName: string } }>(
    "/projects/:handle/:projectName/collaborators",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });

      const [collabResult, rolesResult] = await Promise.all([
        query<{
          handle: string;
          name: string | null;
          picture: string | null;
          role: string;
          project_roles: string[] | null;
        }>(
          `SELECT u.handle, u.name, u.picture, 'Owner' AS role,
                  ARRAY(SELECT pmr.role_name FROM project_member_roles pmr
                        JOIN project_roles pr ON pr.project_id = pmr.project_id AND pr.name = pmr.role_name
                        WHERE pmr.project_id = $2 AND pmr.user_id = u.id
                        ORDER BY pr.position) AS project_roles
           FROM users u WHERE u.id = $1
           UNION ALL
           SELECT u.handle, u.name, u.picture, pc.role::text AS role,
                  ARRAY(SELECT pmr.role_name FROM project_member_roles pmr
                        JOIN project_roles pr ON pr.project_id = pmr.project_id AND pr.name = pmr.role_name
                        WHERE pmr.project_id = $2 AND pmr.user_id = u.id
                        ORDER BY pr.position) AS project_roles
           FROM project_collaborators pc
           JOIN users u ON u.id = pc.user_id
           WHERE pc.project_id = $2`,
          [project.ownerId, project.projectId],
        ),
        query<{ name: string }>(
          `SELECT name FROM project_roles WHERE project_id = $1 ORDER BY position`,
          [project.projectId],
        ),
      ]);

      const systemId = await resolveProjectSystemId(project.projectId);
      const concernsResult = systemId
        ? await query<{
          name: string;
          position: number;
          is_baseline: boolean;
          scope: string | null;
        }>(`SELECT name, position, is_baseline, scope FROM concerns WHERE system_id = $1 ORDER BY position`, [
          systemId,
        ])
        : { rows: [] as { name: string; position: number; is_baseline: boolean; scope: string | null }[] };

      return {
        accessRole: project.accessRole,
        visibility: project.visibility,
        projectRoles: rolesResult.rows.map((r) => r.name),
        concerns: concernsResult.rows.map((r) => ({
          name: r.name,
          position: r.position,
          isBaseline: r.is_baseline,
          scope: r.scope,
        })),
        collaborators: collabResult.rows.map((r) => ({
          handle: r.handle,
          name: r.name,
          picture: r.picture,
          role: r.role,
          projectRoles: r.project_roles ?? [],
        })),
      };
    },
  );

  app.post<{
    Params: { handle: string; projectName: string };
    Body: { name: string };
  }>(
    "/projects/:handle/:projectName/concerns",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.accessRole !== "Owner") return reply.code(403).send({ error: "Only the owner can manage concerns" });

      const { name } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return reply.code(400).send({ error: "name is required" });
      }

      const trimmed = name.trim();
      const systemId = await resolveProjectSystemId(project.projectId);
      if (!systemId) {
        return reply.code(404).send({ error: "Project system not found" });
      }

      const positionResult = await query<{ max: number | null }>(
        "SELECT MAX(position) AS max FROM concerns WHERE system_id = $1",
        [systemId],
      );
      const nextPosition = (positionResult.rows[0].max ?? -1) + 1;

      try {
        await query(
          "INSERT INTO concerns (system_id, name, position, is_baseline, scope) VALUES ($1, $2, $3, $4, $5)",
          [systemId, trimmed, nextPosition, false, null],
        );
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as { code: string }).code === "23505") {
          return reply.code(409).send({ error: "A concern with this name already exists" });
        }
        throw err;
      }

      return reply.code(201).send({
        name: trimmed,
        position: nextPosition,
        isBaseline: false,
        scope: null,
      });
    },
  );

  app.delete<{ Params: { handle: string; projectName: string; concernName: string } }>(
    "/projects/:handle/:projectName/concerns/:concernName",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.accessRole !== "Owner") return reply.code(403).send({ error: "Only the owner can manage concerns" });

      const concernName = req.params.concernName;
      const systemId = await resolveProjectSystemId(project.projectId);
      if (!systemId) {
        return reply.code(404).send({ error: "Project system not found" });
      }

      const [matrixRefs, artifacts] = await Promise.all([
        query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM matrix_refs WHERE system_id = $1 AND concern_hash = md5($2) AND concern = $2",
          [systemId, concernName],
        ),
        query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM artifacts WHERE system_id = $1 AND concern = $2",
          [systemId, concernName],
        ),
      ]);

      const referenced = Number(matrixRefs.rows[0].count) + Number(artifacts.rows[0].count);
      if (referenced > 0) {
        return reply.code(409).send({
          error: "Cannot delete concern while it is still linked to matrix docs or artifacts",
          referenced,
        });
      }

      const result = await query(
        "DELETE FROM concerns WHERE system_id = $1 AND name = $2",
        [systemId, concernName],
      );
      if (result.rowCount === 0) return reply.code(404).send({ error: "Concern not found" });

      return reply.code(204).send();
    },
  );

  app.post<{
    Params: { handle: string; projectName: string };
    Body: { handle: string; role?: string; projectRoles?: string[] };
  }>(
    "/projects/:handle/:projectName/collaborators",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.accessRole !== "Owner") return reply.code(403).send({ error: "Only the owner can add collaborators" });

      const { handle: targetHandle, role, projectRoles } = req.body;
      if (!targetHandle) return reply.code(400).send({ error: "handle is required" });
      if (!projectRoles || !Array.isArray(projectRoles) || projectRoles.length === 0) {
        return reply.code(400).send({ error: "At least one project role is required" });
      }

      const collabRole = role === "Viewer" ? "Viewer" : "Editor";

      const userResult = await query<{ id: string; handle: string; name: string | null; picture: string | null }>(
        "SELECT id, handle, name, picture FROM users WHERE handle = $1",
        [targetHandle],
      );
      if (userResult.rowCount === 0) return reply.code(404).send({ error: "User not found" });

      const target = userResult.rows[0];
      if (target.id === project.ownerId) return reply.code(400).send({ error: "Cannot add the owner as a collaborator" });

      // Validate role names exist
      const validRoles = await query<{ name: string }>(
        "SELECT name FROM project_roles WHERE project_id = $1",
        [project.projectId],
      );
      const validSet = new Set(validRoles.rows.map((r) => r.name));
      for (const rn of projectRoles) {
        if (!validSet.has(rn)) return reply.code(400).send({ error: `Invalid project role: ${rn}` });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO project_collaborators (project_id, user_id, role) VALUES ($1, $2, $3::collaborator_role)",
          [project.projectId, target.id, collabRole],
        );
        await client.query(
          `INSERT INTO project_member_roles (project_id, user_id, role_name)
           SELECT $1, $2, unnest($3::text[])`,
          [project.projectId, target.id, projectRoles],
        );
        await client.query("COMMIT");
      } catch (err: unknown) {
        await client.query("ROLLBACK").catch(() => {});
        if (err instanceof Error && "code" in err && (err as { code: string }).code === "23505") {
          return reply.code(409).send({ error: "User is already a collaborator" });
        }
        throw err;
      } finally {
        client.release();
      }

      return reply.code(201).send({
        handle: target.handle,
        name: target.name,
        picture: target.picture,
        role: collabRole,
        projectRoles,
      });
    },
  );

  app.delete<{ Params: { handle: string; projectName: string; collaboratorHandle: string } }>(
    "/projects/:handle/:projectName/collaborators/:collaboratorHandle",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.accessRole !== "Owner") return reply.code(403).send({ error: "Only the owner can remove collaborators" });

      const userResult = await query<{ id: string }>(
        "SELECT id FROM users WHERE handle = $1",
        [req.params.collaboratorHandle],
      );
      if (userResult.rowCount === 0) return reply.code(404).send({ error: "User not found" });

      const targetId = userResult.rows[0].id;
      await query(
        "DELETE FROM project_member_roles WHERE project_id = $1 AND user_id = $2",
        [project.projectId, targetId],
      );
      const result = await query(
        "DELETE FROM project_collaborators WHERE project_id = $1 AND user_id = $2",
        [project.projectId, targetId],
      );
      if (result.rowCount === 0) return reply.code(404).send({ error: "Not a collaborator" });

      return reply.code(204).send();
    },
  );

  // ── Project Roles ────────────────────────────────────────────

  app.post<{
    Params: { handle: string; projectName: string };
    Body: { name: string };
  }>(
    "/projects/:handle/:projectName/roles",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.accessRole !== "Owner") return reply.code(403).send({ error: "Only the owner can manage roles" });

      const { name } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return reply.code(400).send({ error: "name is required" });
      }

      const maxPos = await query<{ max: number | null }>(
        "SELECT MAX(position) AS max FROM project_roles WHERE project_id = $1",
        [project.projectId],
      );
      const nextPos = (maxPos.rows[0].max ?? -1) + 1;

      try {
        await query(
          "INSERT INTO project_roles (project_id, name, position) VALUES ($1, $2, $3)",
          [project.projectId, name.trim(), nextPos],
        );
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as { code: string }).code === "23505") {
          return reply.code(409).send({ error: "A role with this name already exists" });
        }
        throw err;
      }

      return reply.code(201).send({ name: name.trim(), position: nextPos });
    },
  );

  app.delete<{ Params: { handle: string; projectName: string; roleName: string } }>(
    "/projects/:handle/:projectName/roles/:roleName",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.accessRole !== "Owner") return reply.code(403).send({ error: "Only the owner can manage roles" });

      const assignedCount = await query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM project_member_roles WHERE project_id = $1 AND role_name = $2",
        [project.projectId, req.params.roleName],
      );
      if (Number(assignedCount.rows[0].count) > 0) {
        return reply.code(409).send({ error: "Cannot delete role while users are still assigned to it" });
      }

      const result = await query(
        "DELETE FROM project_roles WHERE project_id = $1 AND name = $2",
        [project.projectId, req.params.roleName],
      );
      if (result.rowCount === 0) return reply.code(404).send({ error: "Role not found" });

      return reply.code(204).send();
    },
  );

  app.put<{
    Params: { handle: string; projectName: string; collaboratorHandle: string };
    Body: { projectRoles: string[] };
  }>(
    "/projects/:handle/:projectName/collaborators/:collaboratorHandle/roles",
    async (req, reply) => {
      const viewerUserId = await getOptionalViewerUserId(req, reply);
      if (typeof viewerUserId === "undefined") return;

      const project = await resolveProject(req.params.handle, req.params.projectName, viewerUserId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (project.accessRole !== "Owner") return reply.code(403).send({ error: "Only the owner can manage roles" });

      const { projectRoles } = req.body;
      if (!projectRoles || !Array.isArray(projectRoles) || projectRoles.length === 0) {
        return reply.code(400).send({ error: "At least one project role is required" });
      }

      // Resolve target user
      const userResult = await query<{ id: string }>(
        "SELECT id FROM users WHERE handle = $1",
        [req.params.collaboratorHandle],
      );
      if (userResult.rowCount === 0) return reply.code(404).send({ error: "User not found" });
      const targetId = userResult.rows[0].id;

      // Must be owner or collaborator
      const isOwner = targetId === project.ownerId;
      if (!isOwner) {
        const collabCheck = await query(
          "SELECT 1 FROM project_collaborators WHERE project_id = $1 AND user_id = $2",
          [project.projectId, targetId],
        );
        if (collabCheck.rowCount === 0) return reply.code(404).send({ error: "Not a project member" });
      }

      // Validate role names
      const validRoles = await query<{ name: string }>(
        "SELECT name FROM project_roles WHERE project_id = $1",
        [project.projectId],
      );
      const validSet = new Set(validRoles.rows.map((r) => r.name));
      for (const rn of projectRoles) {
        if (!validSet.has(rn)) return reply.code(400).send({ error: `Invalid project role: ${rn}` });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "DELETE FROM project_member_roles WHERE project_id = $1 AND user_id = $2",
          [project.projectId, targetId],
        );
        await client.query(
          `INSERT INTO project_member_roles (project_id, user_id, role_name)
           SELECT $1, $2, unnest($3::text[])`,
          [project.projectId, targetId, projectRoles],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      return { projectRoles };
    },
  );
}
