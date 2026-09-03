/**
 * Render `AGENTS.md` from the Harness teaching (`src/Harness.ts`) — the
 * one source both a human coding agent and the org's own agents read.
 *
 * ```
 * bun scripts/agents-md.ts          # write AGENTS.md
 * bun scripts/agents-md.ts --check  # exit 1 if AGENTS.md is stale
 * ```
 */
import { resolve } from "node:path";
import { renderAgentsMd } from "../src/Harness.ts";

const target = resolve(import.meta.dirname, "..", "AGENTS.md");
const expected = renderAgentsMd();

if (process.argv.includes("--check")) {
  const file = Bun.file(target);
  const actual = (await file.exists()) ? await file.text() : undefined;
  if (actual !== expected) {
    process.stderr.write(
      `AGENTS.md is out of date with src/Harness.ts — run \`bun scripts/agents-md.ts\`\n`,
    );
    process.exit(1);
  }
  console.log("AGENTS.md is in sync with src/Harness.ts");
} else {
  await Bun.write(target, expected);
  console.log(`wrote ${target}`);
}
