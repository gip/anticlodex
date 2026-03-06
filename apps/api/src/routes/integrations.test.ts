import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { API_V1_PREFIX, withApiPrefix } from "../api-prefix.js";
import { buildIntegrationCallbackUrl, integrationsRoutes } from "./integrations.js";

test("buildIntegrationCallbackUrl uses the canonical v1 callback path", () => {
  const callbackUrl = buildIntegrationCallbackUrl(
    { protocol: "https", headers: { host: "api.example.com" } },
    "notion",
  );

  assert.equal(callbackUrl, "https://api.example.com/v1/integrations/notion/callback");
});

test("buildIntegrationCallbackUrl honors explicit callback origin override", () => {
  const previous = process.env.INTEGRATION_OAUTH_CALLBACK_ORIGIN;
  process.env.INTEGRATION_OAUTH_CALLBACK_ORIGIN = "https://public-api.example.com/";

  try {
    const callbackUrl = buildIntegrationCallbackUrl(
      { protocol: "http", headers: { host: "localhost:3001" } },
      "notion",
    );
    assert.equal(callbackUrl, "https://public-api.example.com/v1/integrations/notion/callback");
  } finally {
    if (previous === undefined) {
      delete process.env.INTEGRATION_OAUTH_CALLBACK_ORIGIN;
    } else {
      process.env.INTEGRATION_OAUTH_CALLBACK_ORIGIN = previous;
    }
  }
});

test("integration callback route is registered only under the v1 prefix", async (t) => {
  const app = Fastify();
  t.after(async () => {
    await app.close();
  });

  await app.register(integrationsRoutes, { prefix: API_V1_PREFIX });

  const prefixed = await app.inject({
    method: "GET",
    url: withApiPrefix("/integrations/notion/callback"),
  });
  assert.equal(prefixed.statusCode, 400);
  assert.deepEqual(prefixed.json(), { error: "Missing code/state" });

  const unprefixed = await app.inject({
    method: "GET",
    url: "/integrations/notion/callback",
  });
  assert.equal(unprefixed.statusCode, 404);
});
