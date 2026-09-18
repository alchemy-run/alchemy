/**
 * THREAD TOOLS — work is managed as THREADS and POSTS, nothing else.
 *
 * There is no separate ledger: filing work IS posting a thread root
 * into the channel; moving work IS replying into its thread. The
 * feed shows the threads, `explore` walks one, `threads` lists them.
 *
 * Each tool is a static `ToolDef`: declared at module scope, its
 * INIT resolves `Posts` once where the agent's Layer builds, and the
 * handler's one implicit input is the calling session (`AI.Thread`).
 */
import * as AI from "alchemy/AI";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { nameOfKey } from "../Lineage.ts";
import { Posts } from "./Posts.ts";

const channel = AI.Thing("channel", S.String)`
  The channel the thread lives in ("engineering", "root").`;

const text = AI.Thing("text", S.String)`
  The post — markdown, your words. A thread root says what this is,
  why it matters, and what happens next; refs ("owner/repo#N" URLs)
  render as pills.`;

const replyTo = AI.Thing("replyTo", S.optionalKey(S.String))`
  The message this post answers (its id, "p-…") — omit to start a
  NEW thread in the channel.`;

const postIdOut = AI.Thing("id", S.String)`
  The post's id — the thread's root when you started one; explore
  from it, reference it as #<id>, reply to it later.`;

const threadList = AI.Thing(
  "threads",
  S.Array(
    S.Struct({
      id: S.String,
      author: S.String,
      at: S.Number,
      text: S.String,
    }),
  ),
)`
  The channel's threads (root posts), newest first — explore one for
  its replies.`;

export class EmptyPost extends Data.TaggedError("EmptyPost") {
  override get message(): string {
    return "REFUSED: a post is words — write the text and post again.";
  }
}

/** The calling session's frame — author identity rides the key. */
const currentThread = Effect.gen(function* () {
  const thread = Option.getOrUndefined(yield* Effect.serviceOption(AI.Thread));
  return thread === undefined
    ? yield* Effect.die("post/threads outside a session frame")
    : thread;
});

export const post = AI.Tool("post")`
  Write a POST — the one unit of work and record. Omit ${replyTo} to
  start a NEW THREAD in ${channel} (filing work IS posting: the root
  is what everyone reads first); pass it to add to an existing
  thread (progress, status, decisions — the thread carries its own
  history). When the ask you are answering ALREADY lives in a thread
  (the dispatch names it), your reply lands there by itself — never
  post a second thread for the same ask. Takes ${AI.in(text)};
  answers ${AI.out(postIdOut)}. Refused with ${EmptyPost} when the
  text is blank.`(
  Effect.gen(function* () {
    const posts = yield* Posts;
    return Effect.fn(function* (p: {
      channel: string;
      text: string;
      replyTo?: string;
    }) {
      if (p.text.trim().length === 0) return yield* new EmptyPost();
      const me = yield* currentThread;
      const at = yield* Clock.currentTimeMillis;
      const id = `p-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      yield* posts.post({
        id,
        channel: p.channel,
        ...(p.replyTo !== undefined ? { replyTo: p.replyTo } : {}),
        author: nameOfKey(me.key),
        text: p.text,
        status: "settled",
      });
      return { id };
    });
  }),
);

export const threads = AI.Tool("threads")`
  The ${channel}'s THREADS — every root post, newest first, answering
  ${AI.out(threadList)}. This is the work list: check it before
  filing (work already covered by a thread continues THERE — reply,
  never fork a duplicate); explore a root for its replies.`(
  Effect.gen(function* () {
    const posts = yield* Posts;
    return Effect.fn(function* (p: { channel: string }) {
      const stream = yield* posts.list({ channel: p.channel, limit: 500 });
      return {
        threads: stream
          .filter((entry) => entry.replyTo === undefined)
          .reverse()
          .map((entry) => ({
            id: entry.id,
            author: entry.author,
            at: entry.at,
            text:
              entry.text.length > 300
                ? `${entry.text.slice(0, 300)}…`
                : entry.text,
          })),
      };
    });
  }),
);
