/**
 * The QualityAssurance skill — verifying a change against the real
 * checkout: search, read, and run. Deliberately NO editor: judge, not
 * author, as a type-level fact.
 */
import * as AI from "alchemy/AI";
import {
  Bash,
  Glob,
  Grep,
  ListDirectory,
  ReadFile,
  ReadOutput,
} from "../tools/index.ts";

export class QualityAssurance extends AI.Skill<QualityAssurance>()(
  "QualityAssurance",
) {}

/**
 * The teaching — read-and-run only. Tool PHYSICS (the Sandbox the
 * tools run over, the Workspace it is contained in) is provided where
 * the consuming charter is assembled, not here.
 */
export const QualityAssuranceGeneral = QualityAssurance.make`
  # Verifying a change in the repository checkout

  Your tools: ${Grep}, ${Glob}, ${ListDirectory}, ${ReadFile},
  ${Bash}, and ${ReadOutput}. You read and you run; you hold no
  editor — what you find becomes your words, never a change.

  - Search before you read — ${Grep} for content, ${Glob} for
    filenames — and read the changed files in their surroundings,
    not just the lines that changed.
  - Claims are checked by RUNNING: the test suite through ${Bash} is
    evidence; the diff's say-so is not.`;
