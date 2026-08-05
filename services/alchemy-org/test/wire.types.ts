/**
 * Type-level regression tests for the ReviewBot's WIRE surface
 * (alchemy/AI/Wire.ts): the charter's Layer type carries every tool
 * its prose can mention, so renderer coverage is compiler-checked.
 *
 * This file never runs — it exists to fail `tsc` if the inference
 * regresses. Every `@ts-expect-error` is load-bearing twice over: it
 * asserts the error fires today, and if the wire types ever collapse
 * (e.g. `ToolNames` inferring `never`, which would make the coverage
 * check vacuously pass), the expectations go unused and the build
 * breaks.
 */
import type * as AI from "alchemy/AI";
import type { ReviewBotLive } from "../src/ReviewBot.ts";
import type { QualityAssuranceGeneral } from "../src/skills/QualityAssurance.ts";

type Names = AI.ToolNames<typeof ReviewBotLive>;

// the full surface: inline tools AND class-tool splices
const _names: Names[] = ["comment", "sync_checkout", "readDiff", "readIssue"];

// @ts-expect-error — not on the wire
const _unknown: Names = "not_a_tool";

// inputs are typed per tool, from the template's Parameter splices
const _comment: AI.ToolInput<typeof ReviewBotLive, "comment"> = {
  message: "looks good",
};

// @ts-expect-error — message is a string
const _bad: AI.ToolInput<typeof ReviewBotLive, "comment"> = { message: 42 };

const _readDiff: AI.ToolInput<typeof ReviewBotLive, "readDiff"> = {
  pr: { owner: "o", repository: "r", number: 1, url: "https://x" },
};

// the registry contract is USERLAND — apps derive their own shape from
// the core facts (this mirrors ui/components/tool-card.tsx's Renderers)
type Registry<L> = {
  [Name in AI.ToolNames<L> & string]: (input: AI.ToolInput<L, Name>) => 1;
};

// @ts-expect-error — sync_checkout has no renderer
const _incomplete: Registry<typeof ReviewBotLive> = {
  comment: () => 1,
  readDiff: () => 1,
  readIssue: () => 1,
};

const _complete: Registry<typeof ReviewBotLive> = {
  // input is the tool's ACTUAL parameter type, not Record<string, any>
  comment: (input) => (input.message satisfies string, 1),
  readDiff: (input) => (input.pr.number satisfies number, 1),
  readIssue: (input) => (input.issue.number satisfies number, 1),
  sync_checkout: () => 1,
};

// a SKILL's teaching carries its own wire — its tools never surface on
// the host agent's type (encapsulation, mirroring the R channel), so
// coverage for the pack is checked against the skill's make Layer
type SkillNames = AI.ToolNames<typeof QualityAssuranceGeneral>;
const _skillNames: SkillNames[] = [
  "bash",
  "grep",
  "glob",
  "listDirectory",
  "readFile",
  "readOutput",
];

// @ts-expect-error — the QA skill grants no editor (judge, not author)
const _noEditor: SkillNames = "editFile";
