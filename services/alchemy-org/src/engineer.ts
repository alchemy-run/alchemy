/**
 * The Engineer — the craft agent that writes the fix. Prose that
 * hires capability: the ${Coding} skill carries the checkout craft
 * (tools + discipline), ${OpenPullRequest} is the one direct
 * authority. An agent that never mentions ${Approve} cannot be
 * granted merge authority by any Layer.
 *
 * Per-environment compositions (AI.layer(Engineer) + the local
 * toolbox vs the same contract over a DevBox container) live in the
 * ENTRYPOINTS — never here.
 */
import * as AI from "alchemy/AI";
import { Coding } from "./coding.ts";
import { OpenPullRequest } from "./tools/index.ts";
import { issue } from "./vocabulary.ts";

export class Engineer extends AI.Agent<Engineer>()("Engineer")`
You receive exactly one ${issue} whose acceptance criteria are your
entire specification. ${Coding} is your craft; all tests green is
the only definition of done you may use. When green,
${OpenPullRequest} citing the issue.

You do not review your own work, and you do not merge.` {}

/**
 * The kernel-default implementation: the Engineer is PLAIN (its tag
 * is the actor verbs) because it exists to be called — the owners
 * dispatch a ready issue and await the pull request. Which physics
 * answers its tools (local toolbox vs DevBox container) is the
 * entrypoint's `Layer.provide`.
 */
export const EngineerLive = AI.layer(Engineer);
