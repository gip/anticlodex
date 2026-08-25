// The clients build request paths as strings, so nothing fails at compile time
// when a route stops being registered. That is exactly what happened to the
// matrix mutation endpoints: the handlers moved out of the router and the UI
// went on calling four paths that answered 404 for several releases.
//
// This asserts that every endpoint the web and desktop clients call is actually
// registered. Unregistering one now fails CI instead of failing silently in the
// browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { integrationsRoutes } from "./integrations.js";
import { meRoutes } from "./me.js";
import { userRoutes } from "./users.js";
import { v1Routes } from "./v1.js";

// Kept in sync by hand with the apiFetch call sites in apps/web/src/app.tsx and
// apps/desktop/src/renderer/app.tsx.
const CLIENT_ENDPOINTS: Array<[string, string]> = [
  ["GET", "/v1/me"],
  ["GET", "/v1/events"],
  ["GET", "/v1/events/stream"],
  ["GET", "/v1/users/search"],
  ["GET", "/v1/users/:handle"],

  ["GET", "/v1/projects"],
  ["POST", "/v1/projects"],
  ["GET", "/v1/projects/check-name"],
  ["PATCH", "/v1/projects/:handle/:projectName/description"],
  ["PATCH", "/v1/projects/:handle/:projectName/visibility"],
  ["POST", "/v1/projects/:handle/:projectName/archive"],
  ["GET", "/v1/projects/:handle/:projectName/collaborators"],
  ["POST", "/v1/projects/:handle/:projectName/collaborators"],
  ["DELETE", "/v1/projects/:handle/:projectName/collaborators/:collaboratorHandle"],
  ["PUT", "/v1/projects/:handle/:projectName/collaborators/:collaboratorHandle/roles"],
  ["POST", "/v1/projects/:handle/:projectName/concerns"],
  ["DELETE", "/v1/projects/:handle/:projectName/concerns/:concernName"],
  ["POST", "/v1/projects/:handle/:projectName/roles"],
  ["DELETE", "/v1/projects/:handle/:projectName/roles/:roleName"],
  ["GET", "/v1/projects/:handle/:projectName/openship"],
  ["GET", "/v1/projects/:handle/:projectName/openship/remote-changes"],
  ["POST", "/v1/projects/:handle/:projectName/openship/remote-changes"],

  ["GET", "/v1/threads"],
  ["POST", "/v1/threads"],
  ["GET", "/v1/threads/:threadId"],
  ["PATCH", "/v1/threads/:threadId"],
  ["PATCH", "/v1/threads/:threadId/matrix"],
  ["POST", "/v1/threads/:threadId/matrix/refs"],
  ["DELETE", "/v1/threads/:threadId/matrix/refs"],
  ["GET", "/v1/threads/:threadId/matrix/documents"],
  ["POST", "/v1/threads/:threadId/matrix/documents"],
  ["GET", "/v1/threads/:threadId/matrix/documents/:hash"],
  ["PATCH", "/v1/threads/:threadId/matrix/documents/:hash"],
  ["POST", "/v1/threads/:threadId/chat"],
  ["POST", "/v1/threads/:threadId/assistants/:assistantType/runs"],

  ["GET", "/v1/integrations/:provider/status"],
  ["GET", "/v1/integrations/:provider/authorize-url"],
  ["POST", "/v1/integrations/:provider/disconnect"],
];

test("every endpoint the clients call is registered", async () => {
  const app = Fastify();
  await app.register(async (subApp) => {
    await subApp.register(meRoutes);
    await subApp.register(integrationsRoutes);
    await subApp.register(v1Routes);
    await subApp.register(userRoutes);
  }, { prefix: "/v1" });
  await app.ready();

  const missing = CLIENT_ENDPOINTS.filter(([method, url]) => !app.hasRoute({ method: method as "GET", url }));
  assert.deepEqual(missing, [], `these routes are called by a client but not registered: ${JSON.stringify(missing)}`);

  await app.close();
});
