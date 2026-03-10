import { createClient } from "redis";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

const DEFAULT_PREFIX = "acx:api-cache:";
const DEFAULT_TTL_SECONDS = 60;

type CacheStatus = "BYPASS" | "MISS" | "HIT";

export interface CachedResponse {
  body: string;
  contentType: string;
  statusCode: number;
}

export interface AnonymousResponseCacheStore {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

declare module "fastify" {
  interface FastifyContextConfig {
    anonymousCache?: boolean;
  }

  interface FastifyRequest {
    anonymousCacheKey?: string;
    anonymousCacheStatus?: CacheStatus;
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeCacheKey(req: FastifyRequest): string {
  const url = new URL(req.raw.url ?? req.url, "http://acx.local");
  const sorted = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
    return leftKey.localeCompare(rightKey);
  });

  const normalizedQuery = new URLSearchParams();
  for (const [key, value] of sorted) {
    normalizedQuery.append(key, value);
  }

  const query = normalizedQuery.toString();
  return `${req.method}:${url.pathname}${query ? `?${query}` : ""}`;
}

function isCacheableAnonymousRequest(req: FastifyRequest): boolean {
  if (req.method !== "GET") return false;
  if (typeof req.headers.authorization !== "undefined") return false;
  return req.routeOptions.config?.anonymousCache === true;
}

function isCacheableResponse(reply: FastifyReply): boolean {
  if (reply.statusCode !== 200) return false;
  const rawContentType = reply.getHeader("content-type");
  const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("application/json");
}

function coercePayload(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (Buffer.isBuffer(payload)) return payload.toString("utf8");
  return null;
}

class RedisAnonymousResponseCache implements AnonymousResponseCacheStore {
  private readonly client: ReturnType<typeof createClient>;

  private readonly prefix: string;

  private readonly log: FastifyBaseLogger;

  constructor(options: { client: ReturnType<typeof createClient>; prefix: string; log: FastifyBaseLogger }) {
    this.client = options.client;
    this.prefix = options.prefix;
    this.log = options.log;
  }

  async get(key: string): Promise<CachedResponse | null> {
    if (!this.client.isReady) return null;

    try {
      const raw = await this.client.get(this.prefix + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedResponse;
      if (
        typeof parsed.body !== "string"
        || typeof parsed.contentType !== "string"
        || typeof parsed.statusCode !== "number"
      ) {
        return null;
      }
      return parsed;
    } catch (error) {
      this.log.warn({ err: error, key }, "Anonymous cache read failed");
      return null;
    }
  }

  async set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void> {
    if (!this.client.isReady) return;

    try {
      await this.client.set(this.prefix + key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (error) {
      this.log.warn({ err: error, key }, "Anonymous cache write failed");
    }
  }

  async close(): Promise<void> {
    if (!this.client.isOpen) return;

    try {
      await this.client.quit();
    } catch (error) {
      this.log.warn({ err: error }, "Anonymous cache shutdown failed");
    }
  }
}

export async function createRedisAnonymousResponseCache(
  log: FastifyBaseLogger,
): Promise<{ store: AnonymousResponseCacheStore | null; ttlSeconds: number }> {
  const redisUrl = process.env.REDIS_URL?.trim();
  const ttlSeconds = parsePositiveInt(process.env.REDIS_CACHE_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  const prefix = process.env.REDIS_PREFIX?.trim() || DEFAULT_PREFIX;

  if (!redisUrl) {
    return { store: null, ttlSeconds };
  }

  const client = createClient({ url: redisUrl });
  client.on("error", (error) => {
    log.warn({ err: error }, "Anonymous cache Redis client error");
  });

  try {
    await client.connect();
    log.info({ prefix, ttlSeconds }, "Anonymous cache connected");
  } catch (error) {
    log.warn({ err: error }, "Anonymous cache Redis connect failed");
  }

  return {
    store: new RedisAnonymousResponseCache({ client, prefix, log }),
    ttlSeconds,
  };
}

export function registerAnonymousResponseCache(
  app: FastifyInstance,
  options: {
    store: AnonymousResponseCacheStore | null;
    ttlSeconds: number;
  },
): void {
  app.addHook("onRequest", async (req, reply) => {
    req.anonymousCacheStatus = "BYPASS";
    req.anonymousCacheKey = undefined;

    if (!options.store || !isCacheableAnonymousRequest(req)) {
      return;
    }

    const key = normalizeCacheKey(req);
    req.anonymousCacheKey = key;

    try {
      const cached = await options.store.get(key);
      if (!cached) {
        req.anonymousCacheStatus = "MISS";
        return;
      }

      req.anonymousCacheStatus = "HIT";
      reply.code(cached.statusCode);
      reply.header("content-type", cached.contentType);
      reply.send(cached.body);
    } catch (error) {
      req.anonymousCacheStatus = "BYPASS";
      app.log.warn({ err: error, key }, "Anonymous cache lookup failed");
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const status = req.anonymousCacheStatus ?? "BYPASS";
    reply.header("X-Cache", status);

    if (
      status !== "MISS"
      || !options.store
      || !req.anonymousCacheKey
      || !isCacheableResponse(reply)
    ) {
      return payload;
    }

    const body = coercePayload(payload);
    if (body === null) return payload;

    const rawContentType = reply.getHeader("content-type");
    const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
    if (typeof contentType !== "string") return payload;

    try {
      await options.store.set(
        req.anonymousCacheKey,
        {
          body,
          contentType,
          statusCode: reply.statusCode,
        },
        options.ttlSeconds,
      );
    } catch (error) {
      app.log.warn({ err: error, key: req.anonymousCacheKey }, "Anonymous cache persist failed");
    }

    return payload;
  });
}
