import * as AI from "alchemy/AI";
import { ProviderEngineering } from "./process/ProviderEngineering.ts";
import { Bash } from "./coding/Bash.ts";
import { ToolGuidance } from "./coding/ToolGuidance.ts";
import { ProposalsGuidance } from "./github/ProposalsGuidance.ts";
import { SandboxGuidance } from "./sandbox/SandboxGuidance.ts";

/**
 * How AGENTS, SKILLS, and FRAGMENTS are written for the org — prose is
 * code here, and this is its grammar. Activated when a change touches
 * a charter, a teaching, or a shared fragment. Top-level, beside
 * `OrgGuidance.ts`, because charters live in every domain (`coding/`,
 * `review/`) — it belongs to none of them.
 *
 * Every file this teaching names is a REFERENCE (`${X.source}`), and
 * every reference points DOWN the import graph: the domain skills
 * import nothing that splices this one back. The entry skill and the
 * agents splice this file, so it names neither — a splice is evaluated
 * when the module loads, and a cycle would leave one side's class
 * uninitialized depending on which module happens to load first.
 */
export class CharterGuidance extends AI.Skill<CharterGuidance>(import.meta)(
  "CharterGuidance",
) {}

export const CharterGuidanceGeneral = CharterGuidance.make`
  ## Prose is code

  An agent is a bare \`AI.Agent\` tag; its behavior is a charter Layer,
  the \`*Live\` beside the tag: INIT runs once per session (mint tools,
  resolve the tree) and returns the STANCE, a fragment re-rendered
  before every sampling. A skill is a bare \`AI.Skill\` tag whose
  teaching rides its \`*General\` Layer (\`Skill.make\`…\`\`), dormant
  until the agent activates it. A fragment (\`AI.fragment\`) is shared
  doctrine spliced into several stances. A tool's tagged template is
  its description and the parameters it splices are its schema.

  Mention is presence: a stance's toolkit is exactly what its prose
  splices, and every splice charges the Layer's requirement channel,
  so capability is a type-level fact. Authority therefore lives in
  reference topology, not configuration — the editor is granted by
  one Layer in \`coding/\` alone and the Reviewer's Layer graph never
  includes it; no charter names a merge tool, because merging is the
  operator's click. Never widen a stance to "make something work": if
  a capability must be granted, grant it where the domain says so and
  make the grant visible in the Layer graph.

  Doctrine is PLUGGABLE. Guidance lives beside the code it governs, one
  small skill per domain (${ToolGuidance.source}, ${SandboxGuidance.source},
  ${ProposalsGuidance.source}, ${ProviderEngineering.source}), and a stance
  names the skills its work can touch; a skill that grows past one
  domain is two skills. A rule that spans every domain — this one,
  ${CharterGuidance.source}, and the org's entry skill that names it —
  sits at the top of \`src/\`, beside the Worker and its routes, never
  in the folder of the agent that happens to use it most. Shared
  standards that every stance must always hold are fragments
  (the PR standard in \`process/\`), spliced, not activated. Nothing is
  a monolith: there is no file that "contains the conventions".

  Name files by REFERENCE, never by string. A term declared with
  \`import.meta\` (\`AI.Tool<Bash>(import.meta)\`) carries its \`source\`;
  splicing \`\${Bash.source}\` renders ${Bash.source} and grants nothing,
  and the reference follows the file when it moves. Splice the term
  itself only to delegate to it. References point DOWN: a splice is
  evaluated when its module loads, so doctrine never names the agent
  or the entry that splices it — the agent names its doctrine, and a
  file that must be named from both directions is a sign the two
  belong in one. A path typed as a string is the one kind of reference
  that rots; keep it for files that are not terms (a test, a UI
  component) and nothing else.

  A change to a charter's toolkit is a change to its WIRE:
  \`test/wire.types.ts\` pins each charter's tool names and inputs, and
  \`ui/components/tool-card.tsx\` renders them — both move with it.`;
