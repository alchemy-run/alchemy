import * as AI from "alchemy/AI";
import { ReadOutput } from "../artifacts/ReadOutput.ts";
import { Bash } from "./Bash.ts";
import { ReadFile } from "./ReadFile.ts";
import { WriteFile } from "./WriteFile.ts";

/**
 * How a TOOL is written for the org — activated when a change adds or
 * alters one. Prose only: it names files (`${Bash.source}`), never
 * splices a tool, so holding it grants nothing.
 */
export class ToolGuidance extends AI.Skill<ToolGuidance>(import.meta)(
  "ToolGuidance",
) {}

export const ToolGuidanceGeneral = ToolGuidance.make`
  ## Writing a tool

  One file, one tool. A tool's contract (the \`AI.Tool\` tag, its tagged
  template, the \`AI.Parameter\`s it splices) and its \`*Live\` Layer
  live in ONE file named after the tool — ${Bash.source} is the model.
  A parameter lives with its canonical tool and is imported from there
  (\`path\` from ${ReadFile.source}, \`content\` from ${WriteFile.source}),
  never redeclared: two tools spelling the same parameter differently
  is two vocabularies.

  Every tool runs over the session's \`AI.Sandbox\` — the machine that
  holds the checkout — never the Worker's own filesystem or network.
  A failure the model should see is a RESULT: \`Effect.fail(text)\`
  returns to the model as text; a crash is for the driver. Output is
  bounded: \`bash\` truncates, the spill net (\`artifacts/SpillingTools.ts\`)
  parks oversized results in \`Artifacts\`, and ${ReadOutput.source}
  pages them back — a tool never prints unbounded output into the
  transcript. Search physics are deterministic (ripgrep semantics
  honoring the repository's ignores) so a test can assert them.

  Tools are grouped by ACCESS LEVEL, not by agent: \`coding/Toolbox.ts\`
  is Read + Run (what both agents hold); \`coding/Editor.ts\` is the
  ONLY Layer that grants a write. A new read or run tool joins the
  toolbox; a new write tool joins the editor; nothing joins both.

  A new tool on a stance is three edits, and the type-check names the
  one you missed: the tool file; \`test/wire.types.ts\`, which pins each
  charter's wire (\`AI.ToolNames\` / \`AI.ToolInput\`); and
  \`ui/components/tool-card.tsx\`, which renders each tool by name. Its
  test lives in \`test/\` over a real \`SandboxLocal\` in a temp
  directory — real processes, real files, the model the only fake.`;
