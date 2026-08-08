/**
 * Type-level regression tests for the Engineer's WIRE surface
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
import type { GeneralEngineer } from "../src/Engineer.ts";

type Names = AI.ToolNames<typeof GeneralEngineer>;

// the full surface: every tool the stance mentions
const _names: Names[] = [
  "bash",
  "editFile",
  "glob",
  "grep",
  "listDirectory",
  "readFile",
  "readOutput",
  "writeFile",
];

// @ts-expect-error — not on the wire
const _unknown: Names = "not_a_tool";

// inputs are typed per tool, from the template's Parameter splices
const _grep: AI.ToolInput<typeof GeneralEngineer, "grep"> = {
  pattern: "log.*Error",
};

// @ts-expect-error — pattern is a string
const _bad: AI.ToolInput<typeof GeneralEngineer, "grep"> = { pattern: 42 };

// the registry contract is USERLAND — apps derive their own shape from
// the core facts (this mirrors ui/components/tool-card.tsx's Renderers)
type Registry<L> = {
  [Name in AI.ToolNames<L> & string]: (input: AI.ToolInput<L, Name>) => 1;
};

// @ts-expect-error — writeFile has no renderer
const _incomplete: Registry<typeof GeneralEngineer> = {
  bash: () => 1,
  editFile: () => 1,
  glob: () => 1,
  grep: () => 1,
  listDirectory: () => 1,
  readFile: () => 1,
  readOutput: () => 1,
};

const _complete: Registry<typeof GeneralEngineer> = {
  bash: (input) => (input.command satisfies string, 1),
  editFile: (input) => (input.path satisfies string, 1),
  glob: (input) => (input.pattern satisfies string, 1),
  grep: (input) => (input.pattern satisfies string, 1),
  // optionalKey params surface as OPTIONAL keys (the Tool.ts split)
  listDirectory: (input) => (input.path satisfies string | undefined, 1),
  readFile: (input) => (input.path satisfies string, 1),
  readOutput: (input) => (input.outputId satisfies string, 1),
  writeFile: (input) => (input.content satisfies string, 1),
};
