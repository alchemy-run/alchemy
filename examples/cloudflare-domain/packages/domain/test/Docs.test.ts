import * as fs from "node:fs";
import { expect, it } from "@effect/vitest";
import { groups } from "./conformance/cases.ts";
import { blocksOf, linesOf, tabled } from "./conformance/docs.ts";

const page = new URL(
  "../../../../../website/src/content/docs/domain/verifiable-code.mdx",
  import.meta.url,
);

it("scratch", async () => {
  const read = await tabled(groups, (group) => [...group.both, ...(group.known ?? [])]);
  const unread = await tabled(groups, (group) => (group.unread ?? []).map(([e]) => e));
  const out: Array<unknown> = [];
  for (const block of blocksOf(page.pathname)) {
    let lines;
    try {
      lines = await linesOf(block);
    } catch (error) {
      out.push({
        block: `${block.heading} / ${block.title} :${block.line}`,
        parse: String(error).slice(0, 200),
      });
      continue;
    }
    const miss = lines.filter((line) => !read.has(line.text)).map((line) => line.source);
    const missUnread = lines.filter((line) => !unread.has(line.text)).map((line) => line.source);
    out.push({
      block: `${block.heading} / ${block.title} :${block.line}`,
      lines: lines.length,
      notRead: miss,
      notUnread: missUnread,
    });
  }
  fs.writeFileSync("/tmp/docs-sync.json", JSON.stringify(out, null, 1));
  expect(read.size).toBeGreaterThan(1000);
});
