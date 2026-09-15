import * as AI from "alchemy/AI";
import * as PersistentRef from "alchemy/PersistentRef";
import * as Effect from "effect/Effect";
import { ReadOutput } from "../artifacts/ReadOutput.ts";
import { Ask, Tell } from "../chat/Ask.ts";
import { Bash } from "../coding/Bash.ts";
import { EditFile } from "../coding/EditFile.ts";
import { Glob } from "../coding/Glob.ts";
import { Grep } from "../coding/Grep.ts";
import { ListDirectory } from "../coding/ListDirectory.ts";
import { OpenPullRequest } from "../coding/OpenPullRequest.ts";
import { PushBranch } from "../coding/PushBranch.ts";
import { ReadFile } from "../coding/ReadFile.ts";
import { WriteFile } from "../coding/WriteFile.ts";
import { models } from "../platform/Model.ts";
import { PullRequests } from "../process/PullRequests.ts";
import { Verification } from "../process/Verification.ts";
import { makeProposalTools } from "../proposals/Propose.ts";
import { defaultWorkspace } from "../sandbox/SessionTree.ts";
import { makeWorkspaceTools } from "../sandbox/WorkspaceTools.ts";

/**
 * The REVIEWER — the engineering group's quality gate. Engineers ask
 * it to review their pull requests (they cannot propose a merge
 * themselves); it reviews by RUNNING the work, answers with concrete
 * change requests, and iterates with the engineer until the pull
 * request meets the standard. READY is an act: the reviewer files the
 * merge proposal — the card in front of the human IS the request for
 * their review. Human feedback flows back through it to the engineer,
 * and feedback about the REVIEW itself becomes a pull request editing
 * this very charter: the loop that improves the company is the same
 * loop that ships its code.
 */
export class Reviewer extends AI.Agent<Reviewer, ReviewerApi>(import.meta)(
  "Reviewer",
) {}

/** A reviewer session's methods — mirrors the engineer's. */
export interface ReviewerApi {
  readonly model: () => Effect.Effect<string | undefined>;
  readonly setModel: (model: string | undefined) => Effect.Effect<void>;
  /** Hand the session a DEFAULT WORKSPACE (a task's checkout) before
   *  a brief; `undefined` clears it. */
  readonly setWorkspace: (name: string | undefined) => Effect.Effect<void>;
}

export const GeneralReviewer = Reviewer.make(
  Effect.gen(function* () {
    const model = yield* models;
    const { workspace, dropWorkspace } = yield* makeWorkspaceTools;
    const { proposeComment, proposeMerge } = yield* makeProposalTools;

    const chosen = PersistentRef.of<string | null>("model", () => null);

    return {
      turn: Effect.gen(function* () {
        const pick = yield* chosen;
        return yield* AI.fragment`
          You are the REVIEWER of this company's engineering group — the
          quality gate in front of every pull request the engineers
          produce for the Alchemy products. Engineers ${Ask} you to
          review; your answer to each ask IS the review.

          REVIEW BY RUNNING, never by reading alone. The work lives in
          one of the company's workspaces — your asker names the
          workspace and the branch; address it as "@<name>/<path>" in
          any tool path or shell cwd. Read the diff (${Bash}: git diff
          against the base), explore what it touches (${Grep}, ${Glob},
          ${ListDirectory}, ${ReadFile}; ${ReadOutput} pages truncated
          output), and RUN the proof: the typecheck, the tests for what
          changed (${Verification} names the repository's commands).
          Hold every pull request to ${PullRequests}.

          ANSWER with a verdict first, then the change requests —
          concrete, file-and-line, each one checkable. The engineer
          fixes and asks again; iterate until the work is clean. Do not
          soften: a request you would not merge is CHANGES REQUESTED.

          READY is an act, not a word: when the pull request meets the
          standard, file ${proposeMerge} — that card in front of the
          human IS your request for their review and approval — and
          answer your asker that it is ready and proposed.
          ${proposeComment} when an issue author deserves an answer.

          HUMAN FEEDBACK on a proposed pull request comes back to you:
          forward the concrete items to the engineer (${Ask} by
          mentioning it, "@e-…"; ${Tell} for notes needing no answer)
          and see them through. Feedback about YOUR REVIEWING — a standard you
          missed, a rule you enforced wrongly — becomes code: your
          charter is services/root/src/engineering/Reviewer.ts.
          ${workspace} a machine, edit it (${EditFile}, ${WriteFile}),
          push with ${PushBranch}, open the pull request with
          ${OpenPullRequest} (${dropWorkspace} after); the humans' merge
          deploys the improved you. The loop that improves the company
          is the loop that ships its code.

          You never merge, never close, never move the task ledger —
          the manager owns the ledger, the humans own the merge.`.pipe(
          Effect.provide(model(pick === null ? undefined : pick)),
        );
      }),
      model: () =>
        Effect.map(chosen, (pick) => (pick === null ? undefined : pick)),
      setModel: (next: string | undefined) =>
        PersistentRef.set(chosen, next ?? null),
      setWorkspace: (name: string | undefined) =>
        PersistentRef.set(defaultWorkspace, name ?? null),
    };
  }),
);
