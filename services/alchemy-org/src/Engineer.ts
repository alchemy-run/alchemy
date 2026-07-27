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
import { Coding } from "./Coding.ts";
import { OpenPullRequest } from "./tools/index.ts";
import { body, issue, title, type PullRequestRef } from "./Vocabulary.ts";

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
 * A round ends on EVIDENCE, never on the model's claim:
 *
 * - **reply** — the {@link OpenPullRequest} wrapper calls `AI.reply`
 *   the moment the pull request provably exists: the caller resolves
 *   with the TYPED artifact, and the run PARKS, context intact — the
 *   next dispatch to the same key (review feedback) resumes THIS
 *   engineer in THIS worktree.
 * - **refuse** — the budget is a LAW in the turn's guard (the model
 *   cannot be its own circuit breaker): a run that exhausts it fails
 *   typed (`AI.Refused`) instead of burning tokens forever.
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

    const stance = AI.prose`
      You are an engineer on one issue's thread; each task you
      receive is a round of that work. A first ${issue} carries the
      acceptance criteria — your entire specification; later rounds
      carry review feedback on the pull request you opened, to fix
      in this same checkout on the same branch. Your tools operate
      inside your own checkout of the repository — paths are
      repository-relative ("README.md", "docs/x.md"). ${Coding} is
      your craft; done means the criteria are met and the tests are
      green. Then ${openPullRequest} citing the issue. Review and
      merge are someone else's job.`;

    // the GUARD tier: deterministic law over every tick — the budget
    // and its pressure note; the stance itself is constant (the
    // system prompt stays byte-stable; the cache never busts)
    return Effect.fn(function* (tick: AI.TickEvent) {
      if (tick.count >= 60) {
        return yield* Effect.fail(
          new AI.Refused({
            loop: "Engineer",
            reason: "60 samplings without reaching green",
            observed: tick.count,
          }),
        );
      }
      if (tick.count === 45) {
        yield* AI.say`
          45 of your 60 sampling budget is spent. Stop exploring:
          converge on the smallest change that satisfies the acceptance
          criteria and open the pull request now.`;
      }
      return yield* stance;
    });
  }),
);
