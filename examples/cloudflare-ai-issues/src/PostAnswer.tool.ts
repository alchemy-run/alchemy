import * as AI from "@alchemy.run/ai";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Repo } from "./Repo.ts";

/** Hidden in every comment a session posts, so its own comments are never sent back to it. */
export const MARKER = "<!-- ai-issues -->";

/** Post a comment on an issue. */
export class PostAnswer extends AI.Tool<PostAnswer>()("post_answer", {
  description: "Post your answer on the issue as a comment, in Markdown.",
  parameters: Schema.Struct({ issue: Schema.String, markdown: Schema.String }),
  success: Schema.Struct({ url: Schema.String }),
}) {}

export const PostAnswerLive = PostAnswer.make(
  Effect.gen(function* () {
    const comment = yield* GitHub.CreateIssueComment(yield* Repo);

    return Effect.fn(function* ({ issue, markdown }) {
      const posted = yield* comment({
        issue_number: Number(issue),
        body: `${markdown}\n\n${MARKER}`,
      }).pipe(Effect.orDie);
      return { url: posted.html_url };
    });
  }),
).pipe(Layer.provide(GitHub.CreateIssueCommentHttp));
