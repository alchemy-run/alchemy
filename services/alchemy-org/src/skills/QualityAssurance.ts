/**
 * The QualityAssurance skill — verifying a change against the real
 * checkout: search, read, and run. Substrate compositions live in
 * QualityAssuranceLocal.ts / QualityAssuranceWorker.ts.
 */
import * as AI from "alchemy/AI";
import * as Layer from "effect/Layer";
import {
  Bash,
  Glob,
  Grep,
  ListDirectory,
  ReadFile,
  ReadOutput,
} from "../tools/index.ts";
import { ReadToolsLocal, RunToolsLocal } from "../tools/LocalToolbox.ts";
import { ReadToolsSandbox, RunToolsSandbox } from "../tools/SandboxToolbox.ts";

export class QualityAssurance extends AI.Skill<QualityAssurance>()(
  "QualityAssurance",
) {}

/**
 * The teaching — read-and-run only.
 */
export const QualityAssuranceLive = QualityAssurance.make`
  # Verifying a change in the repository checkout

  Your tools: ${Grep}, ${Glob}, ${ListDirectory}, ${ReadFile},
  ${Bash}, and ${ReadOutput}. You read and you run; you hold no
  editor — what you find becomes your words, never a change.

  - Search before you read — ${Grep} for content, ${Glob} for
    filenames — and read the changed files in their surroundings,
    not just the lines that changed.
  - Claims are checked by RUNNING: the test suite through ${Bash} is
    evidence; the diff's say-so is not.`;

export const QualityAssuranceLocal = QualityAssuranceLive.pipe(
  Layer.provide([ReadToolsLocal, RunToolsLocal]),
);

export const QualityAssuranceWorker = QualityAssuranceLive.pipe(
  Layer.provide([ReadToolsSandbox, RunToolsSandbox]),
);
