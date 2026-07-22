import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "../repos.ts";
import { issue, message } from "../vocabulary.ts";

export class Comment extends AI.Tool<Comment>()("comment")`
Comment ${message} on ${issue}.` {}

/** Comment on an issue or pull request (one door — GitHub's issues API). */
export const CommentLive = Layer.effect(
  Comment,
  Effect.gen(function* () {
    const comment = yield* GitHub.CreateIssueComment(testAlchemy);
    return ((input: {
      message: string;
      issue: { owner: string; repository: string; number: number };
    }) =>
      Effect.gen(function* () {
        const created = yield* comment({
          issue_number: input.issue.number,
          body: input.message,
        }).pipe(
          Effect.mapError(
            (error) => `${error.operation} failed: ${error.message}`,
          ),
        );
        return `commented: ${created.html_url}`;
      })) as never;
  }),
);
