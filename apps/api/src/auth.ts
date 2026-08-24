import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { colors, uniqueNamesGenerator, animals } from "unique-names-generator";
import { randomUUID } from "node:crypto";
import { query } from "./db.js";

interface WorkOSPayload extends JWTPayload {
  sub: string;
  client_id?: string;
  scope?: string;
  org_id?: string;
  organization_id?: string;
}

interface UserRow {
  id: string;
  identity_subject: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  handle: string;
  github_handle: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AuthUser {
  id: string;
  identitySubject: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  handle: string;
  githubHandle: string | null;
  orgId: string | null;
  scope: string | null;
  createdAt: Date;
  updatedAt: Date;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthUser;
  }
}

function withProblem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
  instance?: string,
) {
  reply.code(status).type("application/problem+json").send({
    type: "https://tools.ietf.org/html/rfc7807#section-3.1",
    title,
    status,
    detail,
    instance,
  });
}

interface WorkOSUserProfile {
  id: string;
  email: string;
  email_verified: boolean;
  first_name: string | null;
  last_name: string | null;
  name?: string | null;
  profile_picture_url: string | null;
  external_id?: string | null;
  metadata?: Record<string, unknown>;
}

function extractOrgId(payload: WorkOSPayload): string | null {
  const candidates: Array<unknown> = [
    payload.org_id,
    payload.organization_id,
  ];

  const first = candidates.find((value) => typeof value === "string");
  if (typeof first !== "string") return null;

  const normalized = first.trim();
  return normalized.length > 0 ? normalized : null;
}

function mapRow(row: UserRow, scope: string | null, orgId: string | null): AuthUser {
  return {
    id: row.id,
    identitySubject: row.identity_subject,
    email: row.email,
    name: row.name,
    picture: row.picture,
    handle: row.handle,
    githubHandle: row.github_handle,
    orgId,
    scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function generateHandle(): string {
  return uniqueNamesGenerator({ dictionaries: [colors, animals], separator: "-" });
}

function toScope(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fetchUserProfile(
  apiHostname: string,
  apiKey: string,
  userId: string,
): Promise<WorkOSUserProfile> {
  const res = await fetch(
    `https://${apiHostname}/user_management/users/${encodeURIComponent(userId)}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch WorkOS user profile: ${res.status}`);
  }
  return res.json() as Promise<WorkOSUserProfile>;
}

function profileName(profile: WorkOSUserProfile): string | null {
  if (profile.name?.trim()) return profile.name.trim();
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

function profileGithubHandle(profile: WorkOSUserProfile): string | null {
  const candidate = profile.metadata?.github_handle ?? profile.metadata?.githubHandle;
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim();
  return normalized || null;
}

async function findOrCreateUser(
  apiHostname: string,
  apiKey: string,
  payload: WorkOSPayload,
): Promise<AuthUser> {
  const orgId = extractOrgId(payload);
  const requestedScope = toScope(payload.scope);

  const existing = await query<UserRow>("SELECT * FROM users WHERE identity_subject = $1", [
    payload.sub,
  ]);
  if (existing.rows.length > 0) {
    return mapRow(existing.rows[0], requestedScope, orgId);
  }

  const profile = await fetchUserProfile(apiHostname, apiKey, payload.sub);
  const name = profileName(profile);
  const githubHandle = profileGithubHandle(profile);

  // WorkOS's Auth0 migration stores the former Auth0 subject in external_id.
  // Rebind that row to the WorkOS subject so internal user/project IDs survive.
  if (profile.external_id) {
    const migrated = await query<UserRow>(
      `UPDATE users
       SET identity_subject = $1,
           email = $2,
           name = $3,
           picture = $4,
           github_handle = COALESCE($5, github_handle),
           updated_at = now()
       WHERE identity_subject = $6
         AND NOT EXISTS (
           SELECT 1 FROM users existing_subject WHERE existing_subject.identity_subject = $1
         )
       RETURNING *`,
      [
        payload.sub,
        profile.email,
        name,
        profile.profile_picture_url,
        githubHandle,
        profile.external_id,
      ],
    );
    if (migrated.rows.length > 0) {
      return mapRow(migrated.rows[0], requestedScope, orgId);
    }
  }

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const handle = attempt === 0 && githubHandle ? githubHandle : generateHandle();

    try {
      const result = await query<UserRow>(
        `INSERT INTO users (id, identity_subject, email, name, picture, handle, github_handle, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (identity_subject) DO UPDATE SET
           email = EXCLUDED.email,
           name = EXCLUDED.name,
           picture = EXCLUDED.picture,
           github_handle = EXCLUDED.github_handle,
           updated_at = now()
         RETURNING *`,
        [
          randomUUID(),
          payload.sub,
          profile.email,
          name,
          profile.profile_picture_url,
          handle,
          githubHandle,
        ],
      );

      return mapRow(result.rows[0], requestedScope, orgId);
    } catch (err: unknown) {
      const isHandleConflict =
        err instanceof Error &&
        "code" in err &&
        (err as { code: string }).code === "23505" &&
        "constraint" in err &&
        (err as { constraint: string }).constraint === "users_handle_key";

      if (!isHandleConflict || attempt === maxAttempts - 1) throw err;
    }
  }

  throw new Error("Failed to create user after handle collision retries");
}

const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID;
const WORKOS_API_KEY = process.env.WORKOS_API_KEY;
const WORKOS_API_HOSTNAME = (process.env.WORKOS_API_HOSTNAME ?? "api.workos.com")
  .trim()
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");

if (!WORKOS_CLIENT_ID || !WORKOS_API_KEY) {
  throw new Error("WORKOS_CLIENT_ID and WORKOS_API_KEY must be set");
}

const clientId: string = WORKOS_CLIENT_ID;
const apiKey: string = WORKOS_API_KEY;
const apiHostname: string = WORKOS_API_HOSTNAME;
const issuer = `https://${apiHostname}`;
const jwks = createRemoteJWKSet(new URL(`https://${apiHostname}/sso/jwks/${clientId}`));

async function authenticateRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  options: { required: boolean },
): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  if (!header) {
    if (options.required) {
      withProblem(reply, 401, "Unauthorized", "Missing or invalid Authorization header", req.url);
    }
    return null;
  }
  if (!header.startsWith("Bearer ")) {
    withProblem(reply, 401, "Unauthorized", "Missing or invalid Authorization header", req.url);
    return null;
  }

  const token = header.slice(7);

  let workOSPayload: WorkOSPayload;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, algorithms: ["RS256"] });
    if (typeof payload.sub !== "string" || !payload.sub.startsWith("user_")) {
      throw new Error("WorkOS access token has an invalid subject");
    }
    if (typeof payload.client_id === "string" && payload.client_id !== clientId) {
      throw new Error("WorkOS access token belongs to a different application");
    }
    workOSPayload = payload as WorkOSPayload;
  } catch (err) {
    req.log.warn({ err }, "JWT verification failed");
    withProblem(reply, 401, "Unauthorized", "Invalid bearer token", req.url);
    return null;
  }

  try {
    req.auth = await findOrCreateUser(apiHostname, apiKey, workOSPayload);
    return req.auth;
  } catch (err) {
    req.log.error({ err }, "User lookup/creation failed");
    withProblem(reply, 500, "Internal Server Error", "User lookup or creation failed", req.url);
    return null;
  }
}

export async function verifyAuth(req: FastifyRequest, reply: FastifyReply) {
  await authenticateRequest(req, reply, { required: true });
}

export async function verifyOptionalAuth(req: FastifyRequest, reply: FastifyReply) {
  await authenticateRequest(req, reply, { required: false });
}
