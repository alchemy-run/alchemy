/**
 * The QualityAssurance skill — verifying a change against the real
 * checkout: search, read, and run. The Reviewer's craft: it shares
 * the Engineer's checkout (both are keyed by the issue), so it can
 * open the changed files in context and run the test suite itself —
 * but it holds NO edit tools, so the separation of duties (judge,
 * don't author) is a type-level fact, not prose discipline.
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
 * The teaching — read-and-run only:
 * `Layer<QualityAssurance, never, Grep | Glob | ListDirectory |
 * ReadFile | Bash | ReadOutput>`.
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

/**
 * Local composition — READ + RUN only (tools/LocalToolbox.ts): the
 * write group is simply never provided, so judge-not-author is the
 * composition, not a promise.
 */
export const QualityAssuranceLocal = QualityAssuranceLive.pipe(
  Layer.provide([ReadToolsLocal, RunToolsLocal]),
);


/**
 * Cloudflare composition — the SAME teaching, read + run forwarded to
 * the sandbox container: the reviewer explores and tests in the exact
 * worktree the engineer built in, one RPC hop away.
 */
export const QualityAssuranceWorker = QualityAssuranceLive.pipe(
  Layer.provide([ReadToolsSandbox, RunToolsSandbox]),
);
