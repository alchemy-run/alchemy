import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Repo } from "./Repo.ts";

/** Hidden in every comment the bot posts, so it never answers itself. */
export const MARKER = "<!-- issue-bot -->";

/** Post the bot's answer on the issue its Durable Object belongs to. */
export class Comment extends AI.Tool<Comment>()("comment", {
  description:
    "Post a comment on the issue you are working on. Call it exactly once, with your full answer in Markdown.",
  parameters: Schema.Struct({ body: Schema.String }),
  success: Schema.Struct({ url: Schema.String }),
}) {}

export const CommentLive = Comment.make(
  Effect.gen(function* () {
    const createComment = yield* GitHub.CreateIssueComment(yield* Repo);
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.fn(function* ({ body }) {
      // Each Durable Object is one issue; it stored the number when the issue opened.
      const issue = yield* state.storage.get<number>("issue").pipe(Effect.orDie);
      const comment = yield* createComment({
        issue_number: issue!,
        body: `${body}\n\n${MARKER}`,
      }).pipe(Effect.orDie);
      return { url: comment.html_url };
    });
  }),
).pipe(Layer.provide(GitHub.CreateIssueCommentHttp));
