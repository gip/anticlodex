// Integration coverage for the matrix mutation routes. These four endpoints
// were unreachable for several releases -- registered nowhere, returning 404 to
// a UI that called them -- so they are exercised here end to end against a real
// database rather than trusted to a type check.
//
// Requires Postgres. Run with:
//   OPENSHIP_DB_TEST=1 DATABASE_URL=postgres://... pnpm --filter @acx/api test
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import type { FastifyInstance } from "fastify";

const dbTestEnabled = process.env.OPENSHIP_DB_TEST === "1";

const OWNER_ID = "11111111-1111-4111-a111-111111111111";
const PROJECT_ID = "55555555-5555-4555-a555-555555555555";
const THREAD_ID = "77777777-7777-4777-a777-777777777777";

let app: FastifyInstance;
let query: <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount: number | null }>;

// Deletes anything a previous run left behind, including the systems each
// matrix action forked off `mt_sys`, so the suite can be re-run against the
// same database.
async function cleanup() {
  await query(`DELETE FROM threads WHERE project_id = $1`, [PROJECT_ID]);
  await query(`DELETE FROM systems WHERE id LIKE 'mt_sys%'`);
  await query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
  await query(`DELETE FROM users WHERE id = $1`, [OWNER_ID]);
}

async function seed() {
  await cleanup();
  await query(
    `INSERT INTO users (id, handle, name, identity_subject) VALUES ($1, 'matrixowner', 'Owner', $2)`,
    [OWNER_ID, `sub-${OWNER_ID}`],
  );
  await query(
    `INSERT INTO projects (id, name, owner_id, visibility) VALUES ($1, 'matrix-test', $2, 'public')`,
    [PROJECT_ID, OWNER_ID],
  );
  await query("BEGIN");
  await query(
    `INSERT INTO systems (id, name, root_node_id, spec_version) VALUES ('mt_sys', 'matrix', 'mt_root', '1.0')`,
  );
  await query(
    `INSERT INTO nodes (id, system_id, name, kind)
     VALUES ('mt_root', 'mt_sys', 'Root', 'Root'), ('mt_svc', 'mt_sys', 'Payments', 'Process')`,
  );
  await query("COMMIT");
  await query(
    `INSERT INTO concerns (system_id, name, position, is_baseline)
     VALUES ('mt_sys', 'Security', 0, true), ('mt_sys', 'Reliability', 1, true)`,
  );
  await query(
    `INSERT INTO threads (id, title, project_id, created_by, seed_system_id, project_thread_id, status)
     VALUES ($3, 'Matrix thread', $1, $2, 'mt_sys', 1, 'open')`,
    [PROJECT_ID, OWNER_ID, THREAD_ID],
  );
}

const path = (suffix: string) => `/v1/threads/${THREAD_ID}${suffix}`;

// A failed matrix write answers with an RFC 7807 problem document; showing it
// beats debugging a bare status code.
function assertStatus(result: { status: number; body: unknown }, expected: number) {
  assert.equal(result.status, expected, `expected ${expected}, got ${result.status}: ${JSON.stringify(result.body)}`);
}

async function call(method: string, suffix: string, payload?: unknown) {
  const response = await app.inject({
    method: method as "POST",
    url: path(suffix),
    headers: { authorization: "Bearer test" },
    payload: payload as object,
  });
  return { status: response.statusCode, body: response.json() as Record<string, never> };
}

describe("matrix mutation routes", { skip: !dbTestEnabled }, () => {
  before(async () => {
    // The route module installs its own auth preHandler, so the only seam that
    // avoids minting a real WorkOS token is the auth module itself.
    mock.module("../auth.js", {
      namedExports: {
        verifyAuth: async (req: { auth?: unknown }) => {
          req.auth = { id: OWNER_ID, orgId: null };
        },
        verifyOptionalAuth: async (req: { auth?: unknown }) => {
          req.auth = { id: OWNER_ID, orgId: null };
        },
      },
    });

    const [{ default: Fastify }, { v1Routes }, db] = await Promise.all([
      import("fastify"),
      import("./v1.js"),
      import("../db.js"),
    ]);
    query = db.query as typeof query;

    app = Fastify();
    await app.register(v1Routes, { prefix: "/v1" });
    await app.ready();
    await seed();
  });

  after(async () => {
    await cleanup();
    await app.close();
    const db = await import("../db.js");
    await db.close();
  });

  let documentHash = "";
  let editedHash = "";

  it("creates a document and attaches it in one action", async () => {
    const created = await call("POST", "/matrix/documents", {
      kind: "Document",
      title: "Threat model",
      name: "threat-model",
      description: "How payments can be attacked",
      body: "# Threat model\n\nSpoofing, tampering.",
      language: "en",
      sourceType: "local",
      attach: { nodeId: "mt_svc", concerns: ["Security"], refType: "Document" },
    });

    assertStatus(created, 200);
    const document = created.body.document as unknown as { hash: string; title: string; text: string };
    documentHash = document.hash;
    assert.match(documentHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(document.title, "Threat model");
    assert.match(document.text, /^---\nname: threat-model\n/);

    const cell = created.body.cell as unknown as { nodeId: string; concern: string; docs: Array<{ hash: string }> };
    assert.equal(cell.concern, "Security");
    assert.deepEqual(cell.docs.map((doc) => doc.hash), [documentHash]);

    const messages = created.body.messages as unknown as Array<{ role: string; content: string }>;
    assert.equal(messages[0].role, "System");
    assert.equal(messages[0].content, 'In the Payments, the document "Threat model" was added.');
  });

  it("the created document is readable and searchable through the read routes", async () => {
    const read = await app.inject({ method: "GET", url: path(`/matrix/documents/${encodeURIComponent(documentHash)}`) });
    assert.equal(read.statusCode, 200);
    assert.match((read.json() as { document: { text: string } }).document.text, /Spoofing, tampering/);

    const search = await app.inject({ method: "GET", url: path("/matrix/documents?q=tampering") });
    assert.deepEqual((search.json() as { hashes: string[] }).hashes, [documentHash]);
  });

  it("attaches the same document to a second concern", async () => {
    const attached = await call("POST", "/matrix/refs", {
      nodeId: "mt_svc",
      concerns: ["Reliability"],
      docHash: documentHash,
      refType: "Document",
    });

    assertStatus(attached, 200);
    const cell = attached.body.cell as unknown as { concern: string; docs: Array<{ hash: string }> };
    assert.equal(cell.concern, "Reliability");
    assert.deepEqual(cell.docs.map((doc) => doc.hash), [documentHash]);
  });

  it("re-attaching an existing ref changes nothing and leaves no empty system", async () => {
    const before = await query<{ count: string }>(`SELECT count(*) AS count FROM systems`);
    const repeated = await call("POST", "/matrix/refs", {
      nodeId: "mt_svc",
      concerns: ["Reliability"],
      docHash: documentHash,
      refType: "Document",
    });

    assertStatus(repeated, 200);
    assert.deepEqual(repeated.body.messages, []);
    const after = await query<{ count: string }>(`SELECT count(*) AS count FROM systems`);
    assert.equal(after.rows[0].count, before.rows[0].count, "a no-op action must drop its forked system");
  });

  it("rejects an attachment to a node that does not exist", async () => {
    const invalid = await call("POST", "/matrix/refs", {
      nodeId: "mt_missing",
      concerns: ["Security"],
      docHash: documentHash,
      refType: "Document",
    });
    assertStatus(invalid, 400);
    assert.equal(invalid.body.title, "Invalid matrix reference");
  });

  it("editing a document rewrites its hash and repoints every ref", async () => {
    const edited = await call("PATCH", `/matrix/documents/${encodeURIComponent(documentHash)}`, {
      body: "# Threat model\n\nSpoofing, tampering, repudiation.",
    });

    assertStatus(edited, 200);
    assert.equal(edited.body.oldHash, documentHash);
    editedHash = (edited.body.document as unknown as { hash: string }).hash;
    assert.notEqual(editedHash, documentHash);
    // Both concerns pointed at the old hash, so both must have moved.
    assert.equal(edited.body.replacedRefs, 2);

    const refs = await query<{ doc_hash: string }>(
      `SELECT doc_hash FROM matrix_refs WHERE system_id = thread_current_system($1)`,
      [THREAD_ID],
    );
    assert.deepEqual(new Set(refs.rows.map((row) => row.doc_hash)), new Set([editedHash]));
  });

  it("the superseded document is still readable by its old hash", async () => {
    const previous = await query<{ supersedes: string | null }>(
      `SELECT supersedes FROM documents WHERE hash = $2 AND system_id = thread_current_system($1)`,
      [THREAD_ID, editedHash],
    );
    assert.equal(previous.rows[0].supersedes, documentHash);
  });

  it("detaching removes the ref and returns the emptied cell", async () => {
    const removed = await call("DELETE", "/matrix/refs", {
      nodeId: "mt_svc",
      concerns: ["Reliability"],
      docHash: editedHash,
      refType: "Document",
    });

    assertStatus(removed, 200);
    const cell = removed.body.cell as unknown as { concern: string; docs: unknown[] };
    assert.equal(cell.concern, "Reliability");
    assert.deepEqual(cell.docs, [], "an emptied cell must come back empty, not be omitted");

    const messages = removed.body.messages as unknown as Array<{ content: string }>;
    assert.equal(messages[0].content, 'In the Payments, the document "Threat model" was removed.');
  });

  it("a system prompt must live on the root node under the reserved concern", async () => {
    const wrongNode = await call("POST", "/matrix/documents", {
      kind: "Prompt",
      title: "System prompt",
      name: "system-prompt",
      description: "",
      body: "Be helpful.",
      language: "en",
      sourceType: "local",
      attach: { nodeId: "mt_svc", concerns: ["__system_prompt__"], refType: "Prompt" },
    });
    assertStatus(wrongNode, 400);

    const accepted = await call("POST", "/matrix/documents", {
      kind: "Prompt",
      title: "System prompt",
      name: "system-prompt",
      description: "",
      body: "Be helpful.",
      language: "en",
      sourceType: "local",
      attach: { nodeId: "mt_root", concerns: ["__system_prompt__"], refType: "Prompt" },
    });
    assertStatus(accepted, 200);
    assert.match(accepted.body.systemPrompt as unknown as string, /Be helpful\./);
    assert.equal((accepted.body.systemPrompts as unknown as unknown[]).length, 1);
  });

  it("rejects a malformed payload before opening a transaction", async () => {
    const before = await query<{ count: string }>(`SELECT count(*) AS count FROM actions`);
    const invalid = await call("POST", "/matrix/documents", { kind: "NotAKind", title: "x" });
    assertStatus(invalid, 400);
    const after = await query<{ count: string }>(`SELECT count(*) AS count FROM actions`);
    assert.equal(after.rows[0].count, before.rows[0].count);
  });
});
