import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { body, issue, title } from "../vocabulary.ts";

export class OpenIssue extends AI.Tool<OpenIssue>()("openIssue")`
Open a new issue titled ${title} with ${body}. The body must carry
acceptance criteria precise enough that an engineer who has read
nothing else can start work. Returns the created ${issue}.` {}

/**
 * TODO(binding): needs a `GitHub.CreateIssue` binding (one Octokit
 * call). Until it lands this fails MODEL-VISIBLY so a live run
 * degrades to reporting instead of crashing.
 */
export const OpenIssueLive = Layer.succeed(OpenIssue, ((input: {
  title: string;
}) =>
  Effect.fail(
    `openIssue is not wired yet (GitHub.CreateIssue binding is TODO): ` +
      `report the drafted issue ${JSON.stringify(input.title)} in your reply instead`,
  )) as never);
