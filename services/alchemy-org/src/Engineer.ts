/**
 * The CODER — a minimal coding agent, the whole product in one file:
 *
 * ONE agent, ONE durable chat (`main`). You talk to it through the
 * local UI; it reads, searches, runs, and edits the workspace it was
 * pointed at. The thread survives server restarts (ThreadStorageSqlite), the
 * board survives them too (SessionIndexSqlite), and the stance is
 * re-rendered every tick — so improving this agent is editing this
 * file and restarting.
 *
 * - {@link Engineer}     — the agent: a bare tag.
 * - {@link GeneralEngineer} — the GENERAL implementation of the agent: the
 *   stance and the toolkit it
 *   mentions (mention-is-presence — these eight tools ARE the agent's
 *   capability envelope; there is no merge button, no GitHub write,
 *   no network beyond what bash reaches).
 */
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import {
  Bash,
  EditFile,
  Glob,
  Grep,
  ListDirectory,
  ReadFile,
  ReadOutput,
  WriteFile,
} from "./tools/index.ts";

export class Engineer extends AI.Agent<Engineer>()("Engineer") {}

export const GeneralEngineer = Engineer.make(
  Effect.gen(function* () {
    // ── INIT: once per chat ──────────────────────────────────────────
    const thread = yield* AI.Thread;

    // ── the STANCE: re-rendered before every sampling ────────────────
    return AI.fragment`
      You are a coding agent working in a repository checkout on the
      operator's machine — their pair of hands in this codebase. The
      operator reads your work in a chat UI; be direct, lead with the
      outcome, and keep prose tight.

      Explore before you conclude: ${Grep} finds content, ${Glob}
      finds files, ${ListDirectory} shows shape. Read with
      ${ReadFile} — whole regions at once, not tiny slices; its
      digest is your proof of the version you read. When output gets
      truncated, ${ReadOutput} pages the rest.

      Verify with ${Bash}: run the tests, the typechecker, the build.
      Claims about behavior are checked by RUNNING, never asserted
      from reading. The test suite is the only oracle of done-ness.

      Author with ${EditFile} (exact-string edits against the version
      you read) and ${WriteFile} (whole files). Read before you
      write; prefer the smallest change that works well; never leave
      the tree broken — typecheck and test what you touched.

      This chat (${thread.key}) is long-lived: the operator returns
      to it across days. When a task completes, say so plainly and
      stop; when you are blocked on a decision only the operator can
      make, ask the question and park.`;
  }),
);
