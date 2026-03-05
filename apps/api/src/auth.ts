import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { colors, uniqueNamesGenerator, animals } from "unique-names-generator";
import { randomUUID } from "node:crypto";
import { query } from "./db.js";

interface Auth0Payload extends JWTPayload {
  sub: string;
  scope?: string;
  orgId?: string;
  org_id?: string;
  organization?: string;
}

interface UserRow {
  id: string;
  auth0_id: string;
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
  auth0Id: string;
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

function extractOrgId(payload: Auth0Payload): string | null {
  const candidates: Array<unknown> = [
    payload.orgId,
    payload.org_id,
    payload.organization,
    (payload as { [key: string]: unknown })["https://anticlodex.com/org_id"],
    (payload as { [key: string]: unknown })["https://anticlodex.com/organization"],
  ];

  const first = candidates.find((value) => typeof value === "string");
  if (typeof first !== "string") return null;

  const normalized = first.trim();
  return normalized.length > 0 ? normalized : null;
}

function mapRow(row: UserRow, scope: string | null, orgId: string | null): AuthUser {
  return {
    id: row.id,
    auth0Id: row.auth0_id,
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

function deriveOrgId(orgId: string | null, fallbackUserOrg: string | null): string {
  return orgId ?? fallbackUserOrg ?? randomUUID();
}

async function fetchUserProfile(
  domain: string,
  accessToken: string,
): Promise<{ email?: string; name?: string; picture?: string; nickname?: string }> {
  const res = await fetch(`https://${domain}/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch userinfo: ${res.status}`);
  return res.json() as Promise<{ email?: string; name?: string; picture?: string; nickname?: string }>;
}

async function findOrCreateUser(domain: string, payload: Auth0Payload, token: string): Promise<AuthUser> {
  const orgId = extractOrgId(payload);
  const requestedScope = toScope(payload.scope);

  const existing = await query<UserRow>("SELECT * FROM users WHERE auth0_id = $1", [payload.sub]);
  if (existing.rows.length > 0) {
    return mapRow(existing.rows[0], requestedScope, orgId ?? null);
  }

  const profile = await fetchUserProfile(domain, token);

  const isGitHub = payload.sub.startsWith("github|");
  const githubHandle = isGitHub ? (profile.nickname ?? null) : null;

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const handle = isGitHub && profile.nickname ? profile.nickname : generateHandle();

    try {
      const result = await query<UserRow>(
        `INSERT INTO users (id, auth0_id, email, name, picture, handle, github_handle, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (auth0_id) DO UPDATE SET
           email = EXCLUDED.email,
           name = EXCLUDED.name,
           picture = EXCLUDED.picture,
           github_handle = EXCLUDED.github_handle,
           updated_at = now()
         RETURNING *`,
        [
          randomUUID(),
          payload.sub,
          profile.email ?? null,
          profile.name ?? null,
          profile.picture ?? null,
          handle,
          githubHandle,
        ],
      );

      return mapRow(result.rows[0], requestedScope, orgId ?? null);
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

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;

if (!AUTH0_DOMAIN || !AUTH0_AUDIENCE) {
  throw new Error("AUTH0_DOMAIN and AUTH0_AUDIENCE must be set");
}

const domain: string = AUTH0_DOMAIN;
const audience: string = AUTH0_AUDIENCE;
const issuer = `https://${domain}/`;
const jwks = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));

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

  let auth0Payload: Auth0Payload;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    auth0Payload = payload as Auth0Payload;
  } catch (err) {
    req.log.warn({ err }, "JWT verification failed");
    withProblem(reply, 401, "Unauthorized", "Invalid bearer token", req.url);
    return null;
  }

  try {
    req.auth = await findOrCreateUser(domain, auth0Payload, token);
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
