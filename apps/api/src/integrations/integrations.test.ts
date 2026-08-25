import assert from "node:assert/strict";
import test from "node:test";
import { resolveIntegrationStatus } from "./index.js";
import { fetchDocumentByUrl as fetchGoogleDocument, parseSourceUrl as parseGoogleUrl } from "./google.js";
import { fetchDocumentByUrl as fetchNotionDocument, parseSourceUrl as parseNotionUrl } from "./notion.js";
import { isInvalidSourceUrlError } from "./errors.js";
import { sanitizeReturnTo } from "../routes/integrations.js";

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = handler(String(input), init);
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

test("a connected integration holding a refresh token stays connected past token expiry", () => {
  const expired = new Date(Date.now() - 60_000);

  // The next call refreshes transparently, so the user has nothing to do.
  assert.equal(resolveIntegrationStatus("connected", expired, true), "connected");
  // Nothing left to refresh with -- the user has to reconnect.
  assert.equal(resolveIntegrationStatus("connected", expired, false), "expired");

  assert.equal(resolveIntegrationStatus("connected", new Date(Date.now() + 60_000), true), "connected");
  assert.equal(resolveIntegrationStatus("connected", null, false), "connected");
  assert.equal(resolveIntegrationStatus("needs_reauth", null, true), "needs_reauth");
  assert.equal(resolveIntegrationStatus("disconnected", null, true), "disconnected");
});

test("a Google document's table cells are imported once, not twice", async () => {
  const restore = stubFetch(() => ({
    title: "Design notes",
    revisionId: "rev-1",
    body: {
      content: [
        { paragraph: { elements: [{ textRun: { content: "Intro line\n" } }] } },
        {
          table: {
            tableRows: [
              {
                tableCells: [
                  { content: [{ paragraph: { elements: [{ textRun: { content: "Cell A\n" } }] } }] },
                  { content: [{ paragraph: { elements: [{ textRun: { content: "Cell B\n" } }] } }] },
                ],
              },
            ],
          },
        },
      ],
    },
  }));

  try {
    const result = await fetchGoogleDocument("https://docs.google.com/document/d/doc-123/edit", "token");
    assert.equal(result.title, "Design notes");
    assert.equal(result.text, "Intro line\n\nCell A\n\nCell B");
  } finally {
    restore();
  }
});

test("unusable source URLs are reported as invalid input rather than crashing", () => {
  for (const url of [
    "https://docs.google.com/spreadsheets/d/abc/edit",
    "https://example.com/document/d/abc/edit",
    "not a url",
  ]) {
    assert.throws(() => parseGoogleUrl(url), (error: unknown) => isInvalidSourceUrlError(error));
  }

  // A published Google doc cannot be read through the Docs API.
  assert.throws(
    () => parseGoogleUrl("https://docs.google.com/document/d/e/2PACX-1vAbc/pub"),
    (error: unknown) => isInvalidSourceUrlError(error),
  );

  assert.throws(() => parseNotionUrl("https://www.notion.so/Page-Without-An-Id"), (error: unknown) =>
    isInvalidSourceUrlError(error));

  assert.equal(
    parseNotionUrl("https://www.notion.so/team/Some-Page-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?pvs=4").sourceExternalId,
    "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  );
});

test("a Notion page imports every block type across paginated children", async () => {
  const pageId = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
  const restore = stubFetch((url) => {
    if (url.includes("/v1/pages/")) {
      return { id: pageId, url: `https://www.notion.so/${pageId}`, properties: { Name: { type: "title", title: [{ plain_text: "Runbook" }] } } };
    }
    if (url.includes("start_cursor=cursor-2")) {
      return {
        results: [{ id: "b4", type: "to_do", to_do: { rich_text: [{ plain_text: "Ship it" }], checked: true } }],
        has_more: false,
        next_cursor: null,
      };
    }
    if (url.includes(`/v1/blocks/${pageId}/children`)) {
      return {
        results: [
          { id: "b1", type: "heading_1", heading_1: { rich_text: [{ plain_text: "Overview" }] } },
          { id: "b2", type: "bulleted_list_item", has_children: true, bulleted_list_item: { rich_text: [{ plain_text: "First" }] } },
          { id: "b3", type: "code", code: { language: "sql", rich_text: [{ plain_text: "select 1" }] } },
        ],
        has_more: true,
        next_cursor: "cursor-2",
      };
    }
    // Children of the bulleted list item.
    return {
      results: [{ id: "b2a", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Nested" }] } }],
      has_more: false,
      next_cursor: null,
    };
  });

  try {
    const result = await fetchNotionDocument(`https://www.notion.so/${pageId}`, "token");
    assert.equal(result.title, "Runbook");
    assert.equal(
      result.text,
      ["# Runbook", "", "# Overview", "- First", "  - Nested", "```sql\nselect 1\n```", "- [x] Ship it"].join("\n"),
    );
  } finally {
    restore();
  }
});

test("returnTo never sends the user off the frontend origin", () => {
  const webRequest = {
    protocol: "https",
    headers: { host: "api.example.com", origin: "https://app.example.com" },
  };

  assert.equal(sanitizeReturnTo("/settings", webRequest), "https://app.example.com/settings");
  assert.equal(sanitizeReturnTo("https://evil.example/steal", webRequest), "https://app.example.com");
  assert.equal(sanitizeReturnTo(undefined, webRequest), "https://app.example.com");
});

test("a request with no browsable origin resolves to the completion page instead of throwing", () => {
  // An Electron renderer loaded from file:// sends `Origin: null`.
  const desktopRequest = { protocol: "https", headers: { host: "api.example.com", origin: "null" } };

  assert.equal(sanitizeReturnTo("/settings", desktopRequest), "");
  assert.equal(sanitizeReturnTo("app", desktopRequest), "");
  assert.equal(
    sanitizeReturnTo("app", { protocol: "https", headers: { host: "api.example.com", origin: "https://app.example.com" } }),
    "",
  );
});
