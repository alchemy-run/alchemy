/**
 * The EXPLORER — how an agent restores context from ZERO.
 *
 * An ask delivers ONE message; the responder starts with no history
 * (a fresh session per invocation) and pulls exactly the context it
 * decides it needs by walking the message graph: the message it is
 * answering, the chain above it, the replies below one, or the whole
 * thread. Like a recursive language model: start from zero, restore
 * relevant context by calling tools.
 */
import * as AI from "alchemy/AI";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { Posts, type Post } from "./Posts.ts";

const messageId = AI.Thing("message", S.optionalKey(S.String))`
  The message to look from (its id, "p-…"). Omit it to look from the
  message you are answering.`;

const relation = AI.Thing(
  "relation",
  S.Literals(["message", "above", "replies", "thread"]),
)`
  What to read: "message" — that one message; "above" — the chain it
  replies to, oldest first (how the conversation got here); "replies"
  — the messages answering it; "thread" — the whole thread it lives
  in, chronological.`;

const found = AI.Thing(
  "messages",
  S.Array(
    S.Struct({
      id: S.String,
      replyTo: S.optionalKey(S.String),
      author: S.String,
      kind: S.String,
      status: S.String,
      text: S.String,
    }),
  ),
)`
  The messages, in order — each with its id (explore from any of
  them; reference one in text as #<id>).`;

/** The message a session is answering — its invocation's post id. */
const invocationPost = Effect.gen(function* () {
  const thread = yield* Effect.serviceOption(AI.Thread);
  if (Option.isNone(thread)) return undefined;
  const invocations = yield* thread.value.invocations;
  for (let index = invocations.length - 1; index >= 0; index--) {
    const id = invocations[index]!.id;
    if (id.startsWith("p-")) return id;
  }
  return undefined;
});

export class ExploreError extends Data.TaggedError("ExploreError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export class Explore extends (AI.Tool<Explore>(import.meta)("explore")`
  Read the conversation graph around ${messageId} — ${relation} —
  answering ${AI.out(found)}. You start every ask from ZERO: this is
  how you restore the context you need (what was already said, what
  siblings answered, where the thread began). Explore before
  assuming; reference messages by #<id>. Fails with ${ExploreError}
  when the message does not exist.`) {}

export const ExploreLive = Layer.effect(
  Explore,
  Effect.gen(function* () {
    const posts = yield* Posts;
    const shape = (list: ReadonlyArray<Post>) =>
      list.map((post) => ({
        id: post.id,
        ...(post.replyTo !== undefined ? { replyTo: post.replyTo } : {}),
        author: post.author,
        kind: post.kind,
        status: post.status,
        text: post.text,
      }));
    return Effect.fn(function* (p: {
      message?: string;
      relation: "message" | "above" | "replies" | "thread";
    }) {
      const from = p.message ?? (yield* invocationPost);
      if (from === undefined) {
        return yield* new ExploreError({
          reason:
            "no message to look from — this session was not invoked by " +
            "a conversation message; pass an explicit message id",
        });
      }
      switch (p.relation) {
        case "message": {
          const post = yield* posts.get(from);
          if (post === undefined) {
            return yield* new ExploreError({
              reason: `no message "${from}"`,
            });
          }
          return { messages: shape([post]) };
        }
        case "above":
          return { messages: shape(yield* posts.ancestors(from)) };
        case "replies":
          return { messages: shape(yield* posts.replies(from)) };
        case "thread":
          return { messages: shape(yield* posts.thread(from)) };
      }
    });
  }),
);
