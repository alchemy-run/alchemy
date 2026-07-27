/**
 * The Engineer — the craft agent that writes the fix. The DECLARATION
 * is a bare tag; the CHARTER (prose that hires capability) lives with
 * the implementation Layer: the ${Coding} skill carries the checkout
 * craft (tools + discipline), the wrapped {@link OpenPullRequest} is
 * the one direct authority. A charter that never mentions ${Approve}
 * cannot be granted merge authority by any Layer.
 *
 * The Engineer's WORKTREE is not acquired here: `Workspace.perRun`
 * (the entrypoint's layer) binds run key → checkout lazily on first
 * tool use — ONE site owns that join, and `Git.Workspaces` memoizes
 * by key so the PR tool lands in the same tree.
 *
 * Per-environment compositions (EngineerLive + the local toolbox vs
 * the same contract over a DevBox container) live in the ENTRYPOINTS
 * — never here.
 */
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import { Coding } from "../skills/Coding.ts";
import { OpenPullRequest } from "../tools/index.ts";
import { body, issue, title, type PullRequestRef } from "../Vocabulary.ts";

export class Engineer extends AI.Agent<Engineer>()("Engineer") {}

/** The artifact a round answers with: the created pull request. */
type Pr = typeof PullRequestRef.Type;

/**
 * The kernel-default implementation: the Engineer is PLAIN (its tag
 * is the actor verbs) because it exists to be called — the owners
 * dispatch a ready issue and await the pull request. Which physics
 * answers its tools (local toolbox vs DevBox container) is the
 * entrypoint's `Layer.provide`.
 *
 * A round ends on EVIDENCE, never on the model's claim: the
 * {@link OpenPullRequest} wrapper calls `AI.reply` the moment the
 * pull request provably exists — the caller resolves with the TYPED
 * artifact, and the run PARKS, context intact, so the next dispatch
 * to the same key (review feedback) resumes THIS engineer in THIS
 * worktree. (A budget would be the guard tier — a function turn over
 * `AI.TickEvent` — should one ever be warranted.)
 */
export const EngineerLive = Engineer.make(
  Effect.gen(function* () {
    const openService = yield* OpenPullRequest;
    const open = Effect.isEffect(openService)
      ? yield* openService
      : openService;

    const openPullRequest = yield* AI.Tool("open_pull_request")`
      Open the pull request resolving ${issue}, with ${title} and
      ${body} — the body must cite the issue ("Closes #N") and the
      evidence that its criteria are met. Only call this when the work
      in the workspace is complete. On a fix round, this same call
      pushes to the same branch and updates the open pull request.`(
      Effect.fn(function* (params) {
        const created = (yield* open(params)) as { opened: string; pr: Pr };
        // the caller has its answer the moment the artifact exists —
        // the model may keep working (wrap up, comment) afterwards
        yield* AI.reply(created.pr);
        return created;
      }),
    );

    // the stance is CONSTANT — an `Effect<Fragment>` is a valid turn,
    // so returning the prose directly is the whole loop
    return AI.prose`
      You are an engineer on one issue's thread; each task you receive
      is a round of that work.

      ## Rounds

      - A first ${issue} carries the acceptance criteria — your entire
        specification.
      - Later rounds carry review feedback on the pull request you
        opened.

      ## Workspace

      Your tools operate inside the issue's checkout of the repository
      — paths are repository-relative. The reviewer reads and tests in
      this same checkout; leave it as you would a shared desk.

      ## Craft

      ${Coding} is your craft; done means the criteria are met and the
      tests are green. Then ${openPullRequest}.

      Review and merge are someone else's job.`;
  }),
);
