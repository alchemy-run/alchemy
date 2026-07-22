import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { issue, reason } from "../vocabulary.ts";

export class CloseIssue extends AI.Tool<CloseIssue>()("closeIssue")`
Close ${issue} for ${reason}. Closing is a claim that the work is
done or will never be done — the reason must cite the evidence.` {}

/**
 * TODO(binding): needs a `GitHub.UpdateIssue` binding (one Octokit
 * call). Until it lands this fails MODEL-VISIBLY so a live run
 * degrades to reporting instead of crashing.
 */
export const CloseIssueLive = Layer.succeed(CloseIssue, ((input: {
  issue: { number: number };
  reason: string;
}) =>
  Effect.fail(
    `closeIssue is not wired yet (GitHub.UpdateIssue binding is TODO): ` +
      `comment the close rationale on #${input.issue.number} instead — ${input.reason}`,
  )) as never);
