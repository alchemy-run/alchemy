import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import { connected } from "./Repos.ts";
import {
  Bash,
  EditFile,
  Glob,
  Grep,
  ListDirectory,
  OpenPullRequest,
  PushBranch,
  ReadFile,
  ReadOutput,
  WriteFile,
} from "./tools/index.ts";

/**
 * The CODER — a generic coding agent, the whole product in one file:
 *
 * ONE agent, one durable session per chat. You talk to it through the
 * web UI; each session gets its OWN sandbox container (the circular
 * org image — the alchemy repo checked out, installed, compiled), and
 * the agent reads, searches, runs, and edits that tree. Sessions are
 * Durable Objects: the thread and the board survive everything, and
 * the stance is re-rendered every tick — so improving this agent is
 * editing this file and redeploying.
 *
 * - {@link Engineer}     — the agent: a bare tag.
 * - {@link GeneralEngineer} — the GENERAL implementation of the agent: the
 *   stance and the toolkit it
 *   mentions (mention-is-presence — these ten tools ARE the agent's
 *   capability envelope; publishing stops at the pull request — there
 *   is no merge button).
 */
export class Engineer extends AI.Agent<Engineer>()("Engineer") {}

/** Thread keys are `<session>` or `<session>::<thread>` — the session
 *  part names the machine (and thus the one worktree on it). */
const sessionOf = (key: string): string => {
  const at = key.indexOf("::");
  return at < 0 ? key : key.slice(0, at);
};

export const GeneralEngineer = Engineer.make(
  Effect.gen(function* () {
    // ── INIT: once per chat ──────────────────────────────────────────
    const thread = yield* AI.Thread;
    const checkouts = yield* Git.Checkouts;

    // Session keys are `<owner>/<repo>/<name>` — the prefix picks the
    // session's repository from the STATIC connected list (Repos.ts).
    // The checkout claims the machine's one tree under the SESSION key,
    // so every thread of the session (sharing the machine) adopts the
    // same worktree; for the alchemy repo the image's bake IS the tree
    // (adopted in place — warm installs, zero clone). Legacy keys
    // (`main`, `t-…`) skip the claim and work the baked tree directly.
    const session = sessionOf(thread.key);
    let workspace = "the alchemy repository";
    for (const entry of connected) {
      if (!entry.sessions) continue;
      const identity = yield* GitHub.resolveRepository(entry.repository);
      const full = `${identity.owner}/${identity.repository}`;
      if (session.startsWith(`${full}/`)) {
        yield* checkouts
          .checkout({ key: session, remote: GitHub.remote(entry.repository) })
          .pipe(Effect.orDie);
        workspace = full;
        break;
      }
    }

    // ── the STANCE: re-rendered before every sampling ────────────────
    return AI.fragment`
      You are a coding agent working in a checkout of ${workspace}
      on your own machine — the operator's pair of hands in
      this codebase. The operator reads your work in a chat UI; be
      direct, lead with the outcome, and keep prose tight.

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

      Publish when the operator asks: commit your work (bash: git
      add / git commit with a conventional-commit message), push it
      with ${PushBranch} (a topic branch, never a protected one),
      then open the pull request with ${OpenPullRequest}. Publishing
      stops at the pull request — merging is the operator's act, on
      GitHub.

      This chat (${thread.key}) is long-lived: the operator returns
      to it across days. When a task completes, say so plainly and
      stop; when you are blocked on a decision only the operator can
      make, ask the question and park.`;
  }),
);
