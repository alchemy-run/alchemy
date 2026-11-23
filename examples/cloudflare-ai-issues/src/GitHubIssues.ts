import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import { CommentOnIssue } from "./Board/CommentOnIssue.command.ts";
import { Issue } from "./Board/Issue.aggregate.ts";
import { IssueId } from "./Board/Issue.id.ts";
import { ReportIssue } from "./Board/ReportIssue.command.ts";
import { owner, repository } from "./Repo.ts";
import { MARKER } from "./Tools.ts";

/**
 * The repository's events, as commands on the board. Nothing here knows
 * about a process: an opened issue is reported, a reply is recorded, and
 * the board's policy decides what follows.
 */
export const GitHubIssues = Effect.gen(function* () {
  const issues = yield* Issue;

  yield* GitHub.consumeRepositoryEvents(
    { owner, repository, events: ["issues", "issue_comment"] },
    Effect.fn(function* (event) {
      const issueId = IssueId.make(String(event.payload.issue.number));
      // GitHub's delivery id is the command id, so a redelivery changes nothing.
      const once = { commandId: event.id };
      yield* Match.value(event).pipe(
        Match.when({ name: "issues", payload: { action: "opened" } }, ({ payload }) =>
          issues.send(
            new ReportIssue({
              issueId,
              title: payload.issue.title,
              body: payload.issue.body ?? "",
            }),
            once,
          ),
        ),
        Match.when({ name: "issue_comment", payload: { action: "created" } }, ({ payload }) =>
          // A session's own answers arrive here too.
          payload.comment.body.includes(MARKER)
            ? Effect.void
            : issues.send(
                new CommentOnIssue({
                  issueId,
                  commentId: String(payload.comment.id),
                  body: payload.comment.body,
                }),
                once,
              ),
        ),
        Match.orElse(() => Effect.void),
      );
    }, Effect.orDie),
  );
});
