/**
 * The Engineer — the craft agent that writes the fix. The DECLARATION
 * is a bare tag; the CHARTER (prose that hires capability) lives with
 * the implementation Layer: the ${Coding} skill carries the checkout
 * craft (tools + discipline), the wrapped {@link OpenPullRequest} is
 * the one direct authority. A charter that never mentions ${Approve}
 * cannot be granted merge authority by any Layer.
 *
 * Per-environment compositions (EngineerLive + the local toolbox vs
 * the same contract over a DevBox container) live in the ENTRYPOINTS
 * — never here.
 */
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Coding } from "./coding.ts";
import { OpenPullRequest } from "./tools/index.ts";
import { body, issue, title, type PullRequestRef } from "./vocabulary.ts";

export class Engineer extends AI.Agent<Engineer>()("Engineer") {}

/** The artifact an Engineer run resolves with: the created pull request. */
type Pr = typeof PullRequestRef.Type;

/**
 * The kernel-default implementation: the Engineer is PLAIN (its tag
 * is the actor verbs) because it exists to be called — the owners
 * dispatch a ready issue and await the pull request. Which physics
 * answers its tools (local toolbox vs DevBox container) is the
 * entrypoint's `Layer.provide`.
 *
 * The run ends on EVIDENCE, never on the model's claim:
 *
 * - **achieve** — init wraps ${OpenPullRequest} in an inline tool that
 *   records the created PR into a `Ref`; the turn's first line returns
 *   it when set. A dispatch therefore resolves with the TYPED artifact
 *   (the pull request that provably exists) — the composition
 *   primitive for pipelining Engineer → review → merge — and never
 *   with a success claim that quiesced.
 * - **refuse** — the budget guard is deterministic code over
 *   `AI.Tick`: a run that exhausts its budget fails typed
 *   (`AI.Refused`) instead of burning tokens forever.
 */
export const EngineerLive = Engineer.make(
  Effect.gen(function* () {
    // init: setup only (Refs, bindings for tools) — the run is not
    // in scope here; Thread/Tick are turn-time facts
    const openService = yield* OpenPullRequest;
    const open = Effect.isEffect(openService)
      ? yield* openService
      : openService;
    const opened = yield* Ref.make<Pr | undefined>(undefined);

    const openPullRequest = yield* AI.Tool("open_pull_request")`
      Open the pull request resolving ${issue}, with ${title} and
      ${body} — the body must cite the issue ("Closes #N") and the
      evidence that its criteria are met. Only call this when the work
      in the workspace is complete.`((params) =>
      open(params).pipe(
        // the code-observed fact the turn's achieve check reads
        Effect.tap((created) =>
          Ref.set(opened, (created as { pr: Pr }).pr),
        ),
      ),
    );

    return Effect.gen(function* () {
      // ACHIEVE: the artifact concludes the run — dispatch waiters
      // receive the pull request itself, not prose about it
      const pr = yield* Ref.get(opened);
      if (pr !== undefined) return pr;

      const { key } = yield* AI.Thread;
      const { count } = yield* AI.Tick;
      if (count >= 40) {
        return yield* Effect.fail(
          new AI.Refused({
            loop: `Engineer(${key})`,
            reason: "40 samplings without reaching green",
            observed: count,
          }),
        );
      }
      return yield* AI.prose`
        You receive exactly one ${issue} whose acceptance criteria are your
        entire specification. ${Coding} is your craft; all tests green is
        the only definition of done you may use. When green,
        ${openPullRequest} citing the issue.

        You do not review your own work, and you do not merge.`;
    });
  }),
);
