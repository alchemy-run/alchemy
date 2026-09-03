import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import { CharterGuidance, CharterGuidanceGeneral } from "./CharterGuidance.ts";
import { ToolGuidance, ToolGuidanceGeneral } from "./coding/ToolGuidance.ts";
import {
  ProposalsGuidance,
  ProposalsGuidanceGeneral,
} from "./github/ProposalsGuidance.ts";
import {
  SandboxGuidance,
  SandboxGuidanceGeneral,
} from "./sandbox/SandboxGuidance.ts";

/**
 * Working on `services/alchemy-org` ITSELF — the entry to the org's
 * self-knowledge. Deliberately small: the layout, the naming, how a
 * change is verified, and the domain skills a change can touch. Each
 * domain keeps its own guidance beside the code it governs; this skill
 * names them, so activating it exposes them (the skill graph) without
 * repeating them.
 *
 * The org runs the agents that maintain alchemy and lives inside the
 * repository it maintains — a change here changes the hands that make
 * the next change. `AGENTS.md` (for a human coding agent) is the
 * rendering of this skill and the skills it names: ONE source.
 */
export class OrgGuidance extends AI.Skill<OrgGuidance>(import.meta)(
  "OrgGuidance",
) {}

export const OrgGuidanceGeneral = OrgGuidance.make`
  # Working on alchemy-org — the harness

  \`services/alchemy-org\` is the software factory that maintains the
  alchemy repository: coding and review agents whose charters are
  prose, running over sandboxes that hold a checkout, proposing every
  GitHub write to an operator. It lives INSIDE the repository it
  maintains, so a change here changes the hands that make the next
  change. The lift runs in three stages — a human coding agent editing
  this folder; \`alchemy dev\` running the org on the developer's
  machine (sessions in git worktrees, GitHub by polling);
  \`alchemy deploy\` running it live (sessions in microVMs, GitHub by
  webhook). Every stage is held to the same rules. The repository's
  root \`AGENTS.md\` applies in full; this folder adds its own.

  ## The layout is the architecture

  \`src/\` is organized by DOMAIN — what a file acts on — never by kind.
  There is no \`tools/\`, \`agents/\`, \`skills/\`, or \`lib/\`, and no
  barrel \`index.ts\`: import the file.

  - \`coding/\` — the Engineer: its charter, the toolbox (Read + Run),
    the editor (the ONLY Layer that grants a write), the publish pair.
  - \`review/\` — the Reviewer: its charter, the GitHub event router,
    the review tools, the Ledger.
  - \`sandbox/\` — where code runs: a session's machine and its checkout.
  - \`artifacts/\` — what tools print: the \`Artifacts\` store (a temp
    dir locally, the session's sandbox on Cloudflare — the sandbox is
    one physics of it, not its home), output bounding, the spill net,
    and the tool that pages a spilled result back.
  - \`github/\` — the connected repositories, the proposals gate and its
    stores, the UI projections.
  - \`process/\` — HOW the unit the org maintains is built and judged:
    the alchemy repository and the two it moves with, distilled (the
    SDK factory it pins) and floci (the AWS emulator it runs against)
    — the pull request standard, how a change is verified, how a
    provider is written, and one skill for working in each companion
    repository.
  - \`platform/\` — Cloudflare seams: the driver, the database, the model.
  - \`Routes.ts\` is the HTTP API the UI speaks; \`Worker.ts\` composes
    everything onto Cloudflare; this file is the org's own entry, and
    ${CharterGuidance.source} beside it is the grammar of the prose — the
    two rules that span every domain live at the top, in none.

  Names carry the convention: a variant family keeps its prefix
  (\`Sandbox*\`, \`Checkouts*\`, \`Artifacts*\`, \`Proposals*\`); an
  implementation Layer is \`*Live\` (\`*General\` for a teaching, \`*DO\` /
  \`*D1\` / \`*Memory\` for a store). One file, one term — a tool, a
  skill, an agent, each with its Layer. When a file moves, move it with
  \`git mv\`, rewrite the imports, and rewrite the PROSE that names its
  path — doc comments, the README, the guidance; a stale path in a
  comment is a bug (a \`\${Term.source}\` splice follows the file).

  ## The doctrine is pluggable

  Guidance lives beside the code it governs, one skill per domain, and
  you activate what your change touches — no more:

  - ${ToolGuidance} — adding or changing a tool.
  - ${CharterGuidance} — agents, skills, fragments: prose is code.
  - ${SandboxGuidance} — sessions, machines, trees, checkouts.
  - ${ProposalsGuidance} — anything that would write to GitHub.

  A rule that does not fit one of these is a new small skill in the
  domain it belongs to, named here — never a paragraph added to a
  file that "contains the conventions".

  ## Done means verified

  From the repository root, \`pnpm exec tsc -b services/alchemy-org\` is
  clean; in \`services/alchemy-org\`, \`bun test\` and \`pnpm test:e2e
  --project ui\` pass (a deliberate UX change re-blesses the aria
  snapshots and screenshots with \`pnpm test:e2e:update\` — and you LOOK
  at what changed); \`bun scripts/agents-md.ts --check\` confirms
  \`AGENTS.md\` matches this doctrine. \`Worker.ts\` and \`Routes.ts\` are
  touched by every change to the system: single minimal insertions
  there, never a rewrite. Every behavior change ships with its test —
  the standard in \`process/PullRequests.ts\` applies to this service as
  to any other.

  ## Changing this doctrine

  Edit the skill that owns the rule, run \`bun scripts/agents-md.ts\` to
  regenerate \`AGENTS.md\`, and commit both; \`test/guidance.test.ts\`
  fails when they drift. The org's agents activate the same skills when
  their work touches this folder, so what you write here is what they
  will do next.`;

/**
 * The org's doctrine, whole: the entry skill above WITH the domain
 * skills it names, as one Layer — what both charters are given.
 */
export const OrgDoctrine = OrgGuidanceGeneral.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ToolGuidanceGeneral,
      CharterGuidanceGeneral,
      SandboxGuidanceGeneral,
      ProposalsGuidanceGeneral,
    ),
  ),
);

/**
 * `AGENTS.md`, whole — the entry skill and then each domain skill it
 * names, rendered the way the driver renders them for the org's own
 * agents (skill splices become the skills' names, source splices the
 * files' paths). Resolving the paths walks the FileSystem, which is
 * why this is an Effect.
 */
export const renderAgentsMd: Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const teachings = [
    OrgGuidanceGeneral,
    ToolGuidanceGeneral,
    CharterGuidanceGeneral,
    SandboxGuidanceGeneral,
    ProposalsGuidanceGeneral,
  ];
  yield* Effect.forEach(teachings, (teaching) =>
    AI.resolveSources(teaching.refs),
  );
  return [
    "<!-- GENERATED by `bun scripts/agents-md.ts` from src/OrgGuidance.ts and the",
    "     domain skills it names — edit the skill that owns a rule, not this file.",
    "     The org's agents activate the same skills. -->",
    "",
    teachings.map((teaching) => AI.render(teaching)).join("\n\n"),
    "",
  ].join("\n");
});
