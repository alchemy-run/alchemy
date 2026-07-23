import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { issue } from "../vocabulary.ts";

export class OpenPullRequest extends AI.Tool<OpenPullRequest>()(
  "openPullRequest",
)`
Open a pull request resolving ${issue}. Returns the created pull
request reference. The PR body must cite the issue and the evidence
that criteria are met.` {}

/**
 * TODO(workspace): opening a pull request needs branch-push plumbing —
 * the Engineer's workspace must commit to a branch and push it before
 * a PR can reference it (the Workspace component owns that). Until it
 * lands this fails MODEL-VISIBLY (not a defect) so a live run
 * degrades to reporting instead of crashing.
 */
export const OpenPullRequestLive = Layer.succeed(OpenPullRequest, ((input: {
  issue: { number: number };
}) =>
  Effect.fail(
    `openPullRequest is not wired yet (branch-push plumbing is TODO): ` +
      `describe the change for issue #${input.issue.number} in a comment instead`,
  )) as never);
