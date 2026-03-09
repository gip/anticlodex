import type { FastifyInstance } from "fastify";
import { verifyAuth, verifyOptionalAuth, type AuthUser } from "../auth.js";
import { query } from "../db.js";

interface UserRow {
  id: string;
  handle: string;
  name: string | null;
  picture: string | null;
  github_handle: string | null;
  created_at: Date;
}

interface SharedProjectRow {
  name: string;
  description: string | null;
  visibility: "public" | "private";
  owner_handle: string;
  role: string;
  created_at: Date;
}

function getAuthUser(req: { auth?: AuthUser }): AuthUser | null {
  return req.auth ?? null;
}

export async function userRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q: string } }>(
    "/users/search",
    async (req, reply) => {
      await verifyAuth(req, reply);
      if (reply.sent) return;

      const { q } = req.query;
      if (!q || typeof q !== "string" || !q.trim()) {
        return reply.code(400).send({ error: "q is required" });
      }

      const pattern = `%${q.trim()}%`;
      const result = await query<{ handle: string; name: string | null; picture: string | null }>(
        `SELECT handle, name, picture FROM users
         WHERE handle ILIKE $1 OR name ILIKE $1
         LIMIT 10`,
        [pattern],
      );

      return result.rows;
    },
  );

  app.get<{ Params: { handle: string } }>(
    "/users/:handle",
    { config: { anonymousCache: true } },
    async (req, reply) => {
      await verifyOptionalAuth(req, reply);
      if (reply.sent) return;

      const viewerUserId = getAuthUser(req)?.id ?? null;
      const { handle } = req.params;

      const normalizedHandle = handle.trim();
      const userResult = await query<UserRow>(
        `SELECT id, handle, name, picture, github_handle, created_at
         FROM users
         WHERE lower(handle) = lower($1)`,
        [normalizedHandle],
      );

      if (userResult.rowCount === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      const target = userResult.rows[0];

      const projectResult = await query<SharedProjectRow>(
        `SELECT
           p.name,
           p.description,
           p.visibility::text AS visibility,
           owner_u.handle AS owner_handle,
           target_up.access_role AS role,
           p.created_at
         FROM user_projects target_up
         JOIN projects p ON p.id = target_up.id
         JOIN users owner_u ON owner_u.id = p.owner_id
         LEFT JOIN project_collaborators viewer_pc
           ON viewer_pc.project_id = p.id
          AND viewer_pc.user_id = CAST($2 AS uuid)
         WHERE target_up.user_id = $1
           AND p.is_archived = false
           AND (
             p.visibility = 'public'
             OR p.owner_id = CAST($2 AS uuid)
             OR viewer_pc.user_id IS NOT NULL
           )
         ORDER BY p.created_at DESC`,
        [target.id, viewerUserId],
      );

      return {
        handle: target.handle,
        name: target.name,
        picture: target.picture,
        githubHandle: target.github_handle,
        memberSince: target.created_at,
        projects: projectResult.rows.map((row) => ({
          name: row.name,
          description: row.description,
          visibility: row.visibility,
          ownerHandle: row.owner_handle,
          role: row.role,
          createdAt: row.created_at,
        })),
      };
    },
  );
}
