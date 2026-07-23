/**
 * The Engineer — the craft agent that writes the fix. The DECLARATION
 * is a bare tag; the CHARTER (prose that hires capability) lives with
 * the implementation Layer: the ${Coding} skill carries the checkout
 * craft (tools + discipline), ${OpenPullRequest} is the one direct
 * authority. A charter that never mentions ${Approve} cannot be
 * granted merge authority by any Layer.
 *
 * Per-environment compositions (EngineerLive + the local toolbox vs
 * the same contract over a DevBox container) live in the ENTRYPOINTS
 * — never here.
 */
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import { Coding } from "./coding.ts";
import { OpenPullRequest } from "./tools/index.ts";
import { issue } from "./vocabulary.ts";

export class Engineer extends AI.Agent<Engineer>()("Engineer") {}

/**
 * The kernel-default implementation: the Engineer is PLAIN (its tag
 * is the actor verbs) because it exists to be called — the owners
 * dispatch a ready issue and await the pull request. Which physics
 * answers its tools (local toolbox vs DevBox container) is the
 * entrypoint's `Layer.provide`.
 *
 * A bounded loop: the budget guard is deterministic code over
 * `AI.Tick` — a fact plus a typed error, never a prose wish. A run
 * that exhausts its budget REFUSES (typed give-up on the error
 * channel, ratified by the count) instead of burning tokens forever.
 */
export const EngineerLive = Engineer.make(
  Effect.gen(function* () {
    // init: setup only (Refs, bindings for tools) — the run is not
    // in scope here; Thread/Tick are turn-time facts
    return Effect.gen(function* () {
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
        ${OpenPullRequest} citing the issue.

        You do not review your own work, and you do not merge.`;
    });
  }),
);
