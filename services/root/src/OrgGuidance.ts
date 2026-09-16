import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import { CharterGuidance, CharterGuidanceGeneral } from "./CharterGuidance.ts";
import { ToolGuidance, ToolGuidanceGeneral } from "./coding/ToolGuidance.ts";
import {
  SandboxGuidance,
  SandboxGuidanceGeneral,
} from "./sandbox/SandboxGuidance.ts";

/**
 * Working on `services/root` ITSELF — the entry to the company's
 * self-knowledge. Deliberately small: the layout, the naming, how a
 * change is verified, and the domain skills a change can touch. Each
 * domain keeps its own guidance beside the code it governs; this skill
 * names them, so activating it exposes them (the skill graph) without
 * repeating them.
 *
 * The company maintains alchemy and lives inside the repository it
 * maintains — a change here changes the hands that make the next
 * change. `AGENTS.md` (for a human coding agent) is the rendering of
 * this skill and the skills it names: ONE source.
 */
export class OrgGuidance extends AI.Skill<OrgGuidance>(import.meta)(
  "OrgGuidance",
) {}

export const OrgGuidanceGeneral = OrgGuidance.make`
  # Working on root — the company

  \`services/root\` IS the company: an autonomous organization that
  builds and maintains the Alchemy products (alchemy, and its distilled
  and floci submodule repositories), written as code inside the
  repository it maintains — a change here changes the hands that make
  the next change. The bootstrap is Human + Root + Head: the ROOT GROUP
  (\`Root.ts\`, ⊥ — the bottom of the lineage, the static structure
  runtime hangs from) whose CHANNEL is the one conversation the human
  owner holds with the HEAD (\`Head.ts\`, ⊤ — the apex every ask-chain
  bubbles up into). THE STRUCTURE IS CODE, never runtime state: every
  role is an agent charter, every team an \`AI.Group\` declaration; the
  company evolves by editing itself — a new role or process is a file
  in \`src/\`, proposed as a pull request, merged by the human,
  self-deployed. The lift runs in three stages — a human coding agent
  editing this folder; \`alchemy dev\` running the company on the
  developer's machine (workspaces as git worktrees, GitHub by polling);
  \`alchemy deploy\` running it live (workspaces as microVMs, GitHub by
  webhook). Every stage is held to the same rules. The repository's
  root \`AGENTS.md\` applies in full; this folder adds its own.

  ## The layout is the architecture

  \`src/\` is organized by DOMAIN — what a file acts on — never by kind.
  There is no \`tools/\`, \`agents/\`, \`skills/\`, or \`lib/\`, and no
  barrel \`index.ts\`: import the file.

  - \`Root.ts\` + \`Head.ts\` — the bootstrap pair: the Root Group's
    declaration and lineage keys; the Head's charter.
  - \`chat/\` — HOW the company talks: ask (one question, one target,
    chains bubble up — conversation as function calling), tell, call
    (1..* members, a thread inside the thread, humans join), the ask
    TREE, and the Root channel's wire (one file per route).
  - \`engineering/\` — the engineering group: its \`AI.Group\` chart,
    the manager (fronting the TRIAGE QUEUE — the inbound issues/PRs,
    strict FIFO — filing work as THREADS in its channel), and the
    Engineer.
  - \`coding/\` — the SKILL of coding: the toolbox (Read + Run), the
    editor (the ONLY Layer that grants a write), the publish pair
    behind the human gate.
  - \`proposals/\` — the humans' decision seam: every external write
    (merge, comment, close, push, open-PR) is a staged proposal card.
  - \`sandbox/\` — where code runs: workspaces (each an isolated
    machine with the repo checked out), the router, the checkouts.
  - \`artifacts/\` — what tools print: the \`Artifacts\` store (a temp
    dir locally, the session's sandbox on Cloudflare — the sandbox is
    one physics of it, not its home), output bounding, the spill net,
    and the tool that pages a spilled result back.
  - \`github/\` — the connected repositories, the publish token, the
    UI projections.
  - \`process/\` — HOW the unit the org maintains is built and judged:
    the alchemy repository and the two it moves with, distilled (the
    SDK factory it pins) and floci (the AWS emulator it runs against)
    — the pull request standard, how a change is verified, how a
    provider is engineered, the distillation loop that feeds SDK
    mismatches back into distilled, and one emulation skill per cloud
    (floci for AWS, the in-tree \`cloudflare-runtime\` for Cloudflare).
  - \`platform/\` — Cloudflare seams: the driver, the database, the model.
  - \`Api.ts\` is the SUM of every route file (one file, one route,
    beside its domain); \`ApiWorker.ts\` serves it on Cloudflare — the
    only Worker; ${CharterGuidance.source} beside this file is the
    grammar of the prose — the two rules that span every domain live at
    the top, in none.

  Names carry the convention: a variant family keeps its prefix
  (\`Sandbox*\`, \`Checkouts*\`, \`Artifacts*\`); an
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

  A rule that does not fit one of these is a new small skill in the
  domain it belongs to, named here — never a paragraph added to a
  file that "contains the conventions".

  ## Done means verified

  From the repository root, \`pnpm exec tsc -b services/root\` is
  clean; in \`services/root\`, \`bun test\` and \`pnpm test:e2e\` pass;
  \`bun scripts/agents-md.ts --check\` confirms \`AGENTS.md\` matches
  this doctrine. \`Api.ts\` and \`ApiWorker.ts\` are touched by every
  change to the system: single minimal insertions there, never a
  rewrite. Every behavior change ships with its test — the standard in
  \`process/PullRequests.ts\` applies to this service as to any other.

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
export const OrgDoctrine = Layer.provideMerge(OrgGuidanceGeneral, [
  ToolGuidanceGeneral,
  CharterGuidanceGeneral,
  SandboxGuidanceGeneral,
]);

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
