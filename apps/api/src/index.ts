import Fastify from "fastify";
import cors from "@fastify/cors";
import { close, registerPoolErrorHandler } from "./db.js";
import {
  createRedisAnonymousResponseCache,
  registerAnonymousResponseCache,
} from "./anonymous-cache.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { userRoutes } from "./routes/users.js";
import { v1Routes } from "./routes/v1.js";
import { integrationsRoutes } from "./routes/integrations.js";
import { startAgentRunner } from "./agent-runner.js";
import { API_V1_PREFIX } from "./api-prefix.js";

const port = Number(process.env.PORT ?? 3001);
const app = Fastify({ logger: true });
const isClaudeAgentEnabled = process.env.ACX_ENABLE_CLAUDE_AGENT === "1";
const apiPollMsRaw = Number(process.env.ACX_AGENT_RUNNER_POLL_MS ?? "1000");
const apiPollMs = Number.isFinite(apiPollMsRaw) && apiPollMsRaw > 0 ? apiPollMsRaw : 1000;
const anonymousCache = await createRedisAnonymousResponseCache(app.log);

registerPoolErrorHandler(app.log);

registerAnonymousResponseCache(app, anonymousCache);

await app.register(cors, { origin: true, methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"] });

await app.register(async (subApp) => {
    await subApp.register(healthRoutes);
    await subApp.register(meRoutes);
    await subApp.register(integrationsRoutes);
    await subApp.register(v1Routes);
    await subApp.register(userRoutes);
  }, { prefix: API_V1_PREFIX });

const stopAgentRunner = isClaudeAgentEnabled
  ? startAgentRunner({
      pollIntervalMs: apiPollMs,
      runnerId: process.env.ACX_AGENT_RUNNER_ID,
    })
  : () => {};

app.log.info({
  apiVersion: "v1",
  agentRunnerEnabled: isClaudeAgentEnabled,
});

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  stopAgentRunner();
  await anonymousCache.store?.close();
  await close();
  process.exit(1);
}

const shutdown = async () => {
  stopAgentRunner();
  await app.close();
  await anonymousCache.store?.close();
  await close();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
