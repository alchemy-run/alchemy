/**
 * The self-referential lock: `AGENTS.md` (what a human coding agent
 * reads) IS the rendering of the `Harness` skill (what the org's own
 * agents activate). Editing one without regenerating the other fails
 * here — `bun scripts/agents-md.ts` brings them back together.
 */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { HarnessGeneral, renderAgentsMd } from "../src/Harness.ts";

test("AGENTS.md is the rendered Harness teaching", async () => {
  const actual = await Bun.file(
    resolve(import.meta.dirname, "..", "AGENTS.md"),
  ).text();
  expect(actual).toBe(renderAgentsMd());
});

test("the teaching splices read-and-run tools only — both charters can hold it", () => {
  const spliced = HarnessGeneral.refs.map(
    (ref) => (ref as { "~alchemy/Name": string })["~alchemy/Name"],
  );
  expect(new Set(spliced)).toEqual(
    new Set(["bash", "glob", "grep", "listDirectory", "readFile", "readOutput"]),
  );
});
