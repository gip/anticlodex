import DOMPurify, { type Config } from "dompurify";
import { Marked } from "marked";

const markedInstance = new Marked({
  breaks: true,
  gfm: true,
});

// marked does not sanitize its output (the built-in sanitizer was dropped in v5),
// and every caller feeds the result straight into dangerouslySetInnerHTML. The
// sources are all user- or agent-authored — thread and project descriptions,
// document bodies, chat messages — so the HTML is sanitized here, once, rather
// than being trusted at each render site.
// Neither `style` nor `form` is ever produced by marked, so forbidding them costs
// no legitimate formatting: `style` otherwise survives sanitization carrying
// arbitrary CSS, and a form inside rendered user content is a phishing surface.
// GFM task lists still need `input`, so that stays allowed.
const SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["form"],
  FORBID_ATTR: ["style"],
};

export function renderMarkdown(source: string): string {
  const html = markedInstance.parse(source) as string;
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}
