import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { JSDOM } from "jsdom";

type RenderMarkdown = (source: string) => string;

let renderMarkdown: RenderMarkdown;
let parseHTML: (html: string) => Document;

// DOMPurify binds to a window at import time, so the DOM globals have to exist
// before ./markdown is loaded.
before(async () => {
  const dom = new JSDOM("");
  Reflect.set(globalThis, "window", dom.window);
  Reflect.set(globalThis, "document", dom.window.document);
  ({ renderMarkdown } = await import("./markdown.js"));
  parseHTML = (html: string) => new JSDOM(`<div id="root">${html}</div>`).window.document;
});

/** Inspects what the browser would actually build, not just the string. */
function render(source: string) {
  const html = renderMarkdown(source);
  const root = parseHTML(html).getElementById("root")!;
  const elements = [...root.querySelectorAll("*")];
  return {
    html,
    tags: elements.map((element) => element.tagName.toLowerCase()),
    attributes: elements.flatMap((element) => [...element.attributes].map((attr) => attr.name)),
    attributeValues: elements.flatMap((element) => [...element.attributes].map((attr) => attr.value)),
  };
}

describe("renderMarkdown", () => {
  test("strips script, iframe and form elements", () => {
    for (const payload of [
      "<script>alert(1)</script>",
      '<iframe src="https://evil.test"></iframe>',
      '<form><button formaction="javascript:alert(1)">x</button></form>',
    ]) {
      const { tags } = render(payload);
      assert.ok(!tags.includes("script"), `script survived: ${payload}`);
      assert.ok(!tags.includes("iframe"), `iframe survived: ${payload}`);
      assert.ok(!tags.includes("form"), `form survived: ${payload}`);
    }
  });

  test("strips event-handler and style attributes", () => {
    for (const payload of [
      '<img src=x onerror="alert(1)">',
      '<img src="x" oNeRrOr="alert(1)">',
      "<svg/onload=alert(1)>",
      '<body onload=alert(1)>',
      '<div style="background:url(javascript:alert(1))">x</div>',
    ]) {
      const { attributes } = render(payload);
      const dangerous = attributes.filter((name) => name.startsWith("on") || name === "style");
      assert.deepEqual(dangerous, [], `dangerous attribute survived: ${payload}`);
    }
  });

  test("neutralizes javascript: and data: urls in links", () => {
    for (const payload of [
      "[click](javascript:alert(1))",
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    ]) {
      const { attributeValues } = render(payload);
      for (const value of attributeValues) {
        assert.ok(!value.toLowerCase().startsWith("javascript:"), `javascript: url survived: ${payload}`);
        assert.ok(!value.toLowerCase().startsWith("data:text/html"), `data: html url survived: ${payload}`);
      }
    }
  });

  test("preserves ordinary markdown formatting", () => {
    assert.match(renderMarkdown("**bold**"), /<strong>bold<\/strong>/);
    assert.match(renderMarkdown("# Heading"), /<h1>Heading<\/h1>/);
    assert.match(renderMarkdown("`code`"), /<code>code<\/code>/);
    assert.match(renderMarkdown("- a\n- b"), /<li>a<\/li>/);
    assert.match(renderMarkdown("```js\nconst x = 1;\n```"), /<pre><code class="language-js">/);
  });

  test("keeps safe links and fenced code, which the app relies on", () => {
    assert.match(renderMarkdown("[link](https://example.com)"), /href="https:\/\/example\.com"/);
    // GFM task lists render as checkbox inputs; those must survive the form ban.
    assert.match(renderMarkdown("- [x] done"), /<input/);
  });
});
