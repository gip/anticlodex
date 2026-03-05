import { Marked } from "marked";

const markedInstance = new Marked({
  breaks: true,
  gfm: true,
});

export function renderMarkdown(source: string): string {
  return markedInstance.parse(source) as string;
}
