import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "../repos.ts";
import { issue, reason, related } from "../vocabulary.ts";

export class LinkIssues extends AI.Tool<LinkIssues>()("linkIssues")`
Record that ${issue} relates to ${related} (duplicate, blocks, or
informs — say which in ${reason}). Linking is how the org remembers;
an unlinked duplicate will be solved twice.` {}

/**
 * Linking's physics today is a comment naming the relation — GitHub
 * renders the cross-reference on both issues, which is the durable
 * artifact the charter wants. A future `GitHub.UpdateIssue` binding
 * could add real duplicate-marking; the contract won't change.
 */
export const LinkIssuesLive = Layer.effect(
  LinkIssues,
  Effect.gen(function* () {
    const comment = yield* GitHub.CreateIssueComment(testAlchemy);
    return ((input: {
      issue: { number: number };
      related: { number: number };
      reason: string;
    }) =>
      Effect.gen(function* () {
        const created = yield* comment({
          issue_number: input.issue.number,
          body: `Related to #${input.related.number} — ${input.reason}`,
        }).pipe(
          Effect.mapError(
            (error) => `${error.operation} failed: ${error.message}`,
          ),
        );
        return `linked #${input.issue.number} → #${input.related.number}: ${created.html_url}`;
      })) as never;
  }),
);
