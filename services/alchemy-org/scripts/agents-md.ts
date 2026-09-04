/**
 * Render `AGENTS.md` from the org doctrine (`src/OrgGuidance.ts` and the
 * domain skills it names) — the one source both a human coding agent
 * and the org's own agents read.
 *
 * ```
 * bun scripts/agents-md.ts          # write AGENTS.md
 * bun scripts/agents-md.ts --check  # exit 1 if AGENTS.md is stale
 * ```
 */
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { renderAgentsMd } from "../src/OrgGuidance.ts";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.resolve(import.meta.dirname, "..", "AGENTS.md");
  const expected = yield* renderAgentsMd;

  if (process.argv.includes("--check")) {
    const actual = yield* fs
      .readFileString(target)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (actual !== expected) {
      yield* Effect.logError(
        "AGENTS.md is out of date with the guidance skills — run `bun scripts/agents-md.ts`",
      );
      return yield* Effect.sync(() => process.exit(1));
    }
    yield* Effect.log("AGENTS.md is in sync with the guidance skills");
  } else {
    yield* fs.writeFileString(target, expected);
    yield* Effect.log(`wrote ${target}`);
  }
});

await Effect.runPromise(program.pipe(Effect.provide(BunServices.layer)));
