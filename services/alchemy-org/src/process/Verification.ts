import * as AI from "alchemy/AI";
import { Bash } from "../coding/Bash.ts";
import { Glob } from "../coding/Glob.ts";
import { Grep } from "../coding/Grep.ts";
import { ListDirectory } from "../coding/ListDirectory.ts";
import { ReadFile } from "../coding/ReadFile.ts";
import { ReadOutput } from "../artifacts/ReadOutput.ts";

/**
 * VERIFICATION — how a change to alchemy is checked against the real
 * checkout: search, read, RUN, with the repository's own commands.
 * Read-and-run tools only, so both charters can hold it and the
 * Reviewer stays a judge (no editor) as a type-level fact.
 */
export class Verification extends AI.Skill<Verification>(import.meta)(
  "Verification",
) {}

export const VerificationGeneral = Verification.make`
  # Verifying a change to alchemy

  Your tools: ${Grep}, ${Glob}, ${ListDirectory}, ${ReadFile}, ${Bash},
  and ${ReadOutput}. You read and you run; what you find becomes your
  words. Search before you read — ${Grep} for content, ${Glob} for
  filenames, ${ListDirectory} for shape — and read changed files in
  their surroundings, whole regions at once, not just the lines that
  changed.

  Claims are checked by RUNNING. A description's verification report
  is a claim like any other until you have run what it names; a diff's
  say-so is not evidence. From the repository root:

  - \`pnpm exec tsc -b\` — the whole workspace type-checks (CI fails
    otherwise). A change to \`distilled/\` alone needs no rebuild: tests
    resolve it from source.
  - \`timeout 240 pnpm test test/{Cloud}/{Service}/{Resource}.test.ts
    --profile testing\` — one suite against the real cloud (paths are
    relative to \`packages/alchemy\`; \`-t "name"\` narrows further).
    Hitting the wall IS the failure: read the partial output and the
    run's log under \`packages/alchemy/.alchemy/log/test/\`, find the
    hang (an unbounded retry, infinite pagination), and name it. Never
    re-run hoping.
  - \`pnpm docs:check-jsdoc\` after a change to a resource's JSDoc;
    generated pages under \`website/src/content/docs/providers/\` are
    never edited by hand.
  - In \`services/alchemy-org\`: \`bun test\`, \`pnpm test:e2e --project
    ui\`, and \`bun scripts/agents-md.ts --check\`.

  A green test that leaves cloud resources behind is a provider bug by
  definition — verify out-of-band that what the test created is gone.
  Report what you ran, what passed, what you could not run and exactly
  why; a verdict names its evidence.`;
