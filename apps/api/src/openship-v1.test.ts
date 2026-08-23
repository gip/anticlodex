import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSources } from "@openshipdev/protocol";
import type { PoolClient } from "pg";
import { emptySources, exportSystems, populateOpenShipSystem, verifyImportSnapshot } from "./openship-v1.js";

const examples = join(import.meta.dirname, "..", "..", "..", "skills", "openship", "references", "examples");
const fixture = async (kind: "valid" | "invalid", name: string) => JSON.parse(await readFile(join(examples, kind, name), "utf8"));

test("creates a conformant empty Sources snapshot for blank projects", () => {
  const source = emptySources({ name: "Blank", description: "A blank project." });
  const verified = validateSources(source.manifest, source.bundle);
  assert.equal(verified.files.length, 0);
  assert.equal(verified.decodedBytes, 0);
});

test("accepts Sources-only imports without inventing a Systems document", async () => {
  const imported = verifyImportSnapshot({
    kind: "sources",
    manifest: await fixture("valid", "sources-manifest.json"),
    bundle: await fixture("valid", "sources-bundle.json"),
  });
  assert.equal(imported.kind, "sources");
  assert.equal(imported.systems, null);
  assert.equal(imported.verified.files.length, 2);
});

test("accepts complete Systems imports and rejects malformed snapshots", async () => {
  const imported = verifyImportSnapshot({ kind: "systems", document: await fixture("valid", "systems.json") });
  assert.equal(imported.kind, "systems");
  assert.ok(imported.systems);
  assert.throws(() => verifyImportSnapshot({ kind: "systems", document: { openship: "2.0" } }));
  assert.throws(() => verifyImportSnapshot({ kind: "unknown" }));
});

test("maps a Sources-only import to exactly one generated Root node", async () => {
  const imported = verifyImportSnapshot({
    kind: "sources",
    manifest: await fixture("valid", "sources-manifest.json"),
    bundle: await fixture("valid", "sources-bundle.json"),
  });
  const statements: string[] = [];
  const client = {
    query: async (text: string) => {
      statements.push(text.replace(/\s+/g, " ").trim());
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  await populateOpenShipSystem(client, {
    systemId: "system.test",
    fallbackName: "Example",
    origin: "https://example.com",
    discovery: null,
    verified: imported.verified,
    systems: null,
  });
  assert.equal(statements.filter((statement) => statement.startsWith("INSERT INTO nodes")).length, 1);
  assert.equal(statements.filter((statement) => statement.startsWith("INSERT INTO edges")).length, 0);
  assert.equal(statements.filter((statement) => statement.startsWith("INSERT INTO artifacts")).length, 0);
  assert.equal(statements.filter((statement) => statement.startsWith("INSERT INTO concerns")).length, 0);
});

test("round-trips a complete Systems document through PostgreSQL", { skip: process.env.OPENSHIP_DB_TEST !== "1" }, async () => {
  const pool = (await import("./db.js")).default;
  const document = await fixture("valid", "systems.json");
  document.vendorExtension = { retained: true };
  const imported = verifyImportSnapshot({ kind: "systems", document });
  const client = await pool.connect();
  const systemId = randomUUID();
  try {
    await client.query("BEGIN");
    await populateOpenShipSystem(client, {
      systemId,
      fallbackName: "Example",
      origin: "https://example.com",
      discovery: null,
      verified: imported.verified,
      systems: imported.systems,
    });
    const exported = await exportSystems(client, systemId);
    assert.equal(exported.source.manifest.digest, document.source.manifest.digest);
    assert.deepEqual(exported.vendorExtension, { retained: true });
    assert.equal((exported.system.nodes as unknown[]).length, document.system.nodes.length);
    assert.equal((exported.system.edges as unknown[]).length, document.system.edges.length);
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
});
