import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  type CachedResponse,
  registerAnonymousResponseCache,
  type AnonymousResponseCacheStore,
} from "./anonymous-cache.js";

class MemoryCacheStore implements AnonymousResponseCacheStore {
  readonly entries = new Map<string, CachedResponse>();

  async get(key: string) {
    return this.entries.get(key) ?? null;
  }

  async set(key: string, value: CachedResponse, _ttlSeconds: number) {
    this.entries.set(key, value);
  }

  async close() {}
}

class ThrowingReadCacheStore implements AnonymousResponseCacheStore {
  async get(_key: string): Promise<CachedResponse | null> {
    throw new Error("read failed");
  }

  async set(_key: string, _value: CachedResponse, _ttlSeconds: number): Promise<void> {
    throw new Error("write should not run");
  }

  async close() {}
}

class ThrowingWriteCacheStore implements AnonymousResponseCacheStore {
  async get(_key: string): Promise<CachedResponse | null> {
    return null;
  }

  async set(_key: string, _value: CachedResponse, _ttlSeconds: number): Promise<void> {
    throw new Error("write failed");
  }

  async close() {}
}

async function buildApp(store: AnonymousResponseCacheStore | null): Promise<FastifyInstance> {
  const app = Fastify();
  registerAnonymousResponseCache(app, { store, ttlSeconds: 60 });

  let cachedHits = 0;
  app.get(
    "/cached",
    { config: { anonymousCache: true } },
    async (req) => {
      cachedHits += 1;
      return {
        hits: cachedHits,
        query: req.query,
      };
    },
  );

  let uncachedHits = 0;
  app.get("/uncached", async () => {
    uncachedHits += 1;
    return { hits: uncachedHits };
  });

  let notFoundHits = 0;
  app.get(
    "/not-found",
    { config: { anonymousCache: true } },
    async (_req, reply) => {
      notFoundHits += 1;
      return reply.code(404).send({ hits: notFoundHits });
    },
  );

  let plainTextHits = 0;
  app.get(
    "/plain-text",
    { config: { anonymousCache: true } },
    async (_req, reply) => {
      plainTextHits += 1;
      return reply.type("text/plain").send(String(plainTextHits));
    },
  );

  await app.ready();
  return app;
}

test("anonymous first request misses and second request hits cache", async (t) => {
  const app = await buildApp(new MemoryCacheStore());
  t.after(async () => {
    await app.close();
  });

  const first = await app.inject({ method: "GET", url: "/cached" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-cache"], "MISS");
  assert.equal(first.json().hits, 1);

  const second = await app.inject({ method: "GET", url: "/cached" });
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["x-cache"], "HIT");
  assert.equal(second.json().hits, 1);
});

test("query strings are normalized into the same cache key", async (t) => {
  const app = await buildApp(new MemoryCacheStore());
  t.after(async () => {
    await app.close();
  });

  const first = await app.inject({ method: "GET", url: "/cached?b=2&a=1" });
  assert.equal(first.headers["x-cache"], "MISS");
  assert.equal(first.json().hits, 1);

  const second = await app.inject({ method: "GET", url: "/cached?a=1&b=2" });
  assert.equal(second.headers["x-cache"], "HIT");
  assert.equal(second.json().hits, 1);
});

test("authenticated requests bypass the anonymous cache", async (t) => {
  const app = await buildApp(new MemoryCacheStore());
  t.after(async () => {
    await app.close();
  });

  const first = await app.inject({
    method: "GET",
    url: "/cached",
    headers: { authorization: "Bearer token" },
  });
  assert.equal(first.headers["x-cache"], "BYPASS");
  assert.equal(first.json().hits, 1);

  const second = await app.inject({
    method: "GET",
    url: "/cached",
    headers: { authorization: "Bearer token" },
  });
  assert.equal(second.headers["x-cache"], "BYPASS");
  assert.equal(second.json().hits, 2);
});

test("uncached routes report bypass", async (t) => {
  const app = await buildApp(new MemoryCacheStore());
  t.after(async () => {
    await app.close();
  });

  const first = await app.inject({ method: "GET", url: "/uncached" });
  assert.equal(first.headers["x-cache"], "BYPASS");
  assert.equal(first.json().hits, 1);

  const second = await app.inject({ method: "GET", url: "/uncached" });
  assert.equal(second.headers["x-cache"], "BYPASS");
  assert.equal(second.json().hits, 2);
});

test("non-200 and non-json responses are not stored", async (t) => {
  const app = await buildApp(new MemoryCacheStore());
  t.after(async () => {
    await app.close();
  });

  const notFoundFirst = await app.inject({ method: "GET", url: "/not-found" });
  assert.equal(notFoundFirst.statusCode, 404);
  assert.equal(notFoundFirst.headers["x-cache"], "MISS");
  assert.equal(notFoundFirst.json().hits, 1);

  const notFoundSecond = await app.inject({ method: "GET", url: "/not-found" });
  assert.equal(notFoundSecond.statusCode, 404);
  assert.equal(notFoundSecond.headers["x-cache"], "MISS");
  assert.equal(notFoundSecond.json().hits, 2);

  const plainTextFirst = await app.inject({ method: "GET", url: "/plain-text" });
  assert.equal(plainTextFirst.statusCode, 200);
  assert.equal(plainTextFirst.headers["x-cache"], "MISS");
  assert.equal(plainTextFirst.body, "1");

  const plainTextSecond = await app.inject({ method: "GET", url: "/plain-text" });
  assert.equal(plainTextSecond.statusCode, 200);
  assert.equal(plainTextSecond.headers["x-cache"], "MISS");
  assert.equal(plainTextSecond.body, "2");
});

test("cache read failures fall back without a 5xx", async (t) => {
  const app = await buildApp(new ThrowingReadCacheStore());
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({ method: "GET", url: "/cached" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-cache"], "BYPASS");
  assert.equal(response.json().hits, 1);
});

test("cache write failures do not break the request path", async (t) => {
  const app = await buildApp(new ThrowingWriteCacheStore());
  t.after(async () => {
    await app.close();
  });

  const first = await app.inject({ method: "GET", url: "/cached" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-cache"], "MISS");
  assert.equal(first.json().hits, 1);

  const second = await app.inject({ method: "GET", url: "/cached" });
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["x-cache"], "MISS");
  assert.equal(second.json().hits, 2);
});
