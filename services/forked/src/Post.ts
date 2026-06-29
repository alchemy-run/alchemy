import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * How a post came to exist.
 *
 * - `post`  — a root post, generated from a prompt against an empty repository.
 * - `fork`  — a retweet-style fork: a full branch of the parent's repository.
 * - `reply` — a reply that forks the parent's repository to build on top of it.
 */
export type PostKind = "post" | "fork" | "reply";

/** Coordinates of the Artifacts repository that holds a post's code. */
export interface RepoRef {
  /** Repository name inside the {@link Repos} namespace. */
  name: string;
  /** Git remote URL clients clone/push against. */
  remote: string;
}

/**
 * A pointer from a post to one of its replies/forks. A post stores a list of
 * these, and each one names another `Post` Durable Object instance — that is
 * the edge of the graph.
 */
export interface ReplyPointer {
  /** The child post's id (its Durable Object name). */
  id: string;
  kind: Extract<PostKind, "fork" | "reply">;
  /** The prompt that generated the child. */
  prompt: string;
  createdAt: number;
}

/** Everything a single post knows about itself. */
export interface PostRecord {
  id: string;
  kind: PostKind;
  /** The prompt this post (or fork/reply) was generated from. */
  prompt: string;
  /** The post this one forked from, or `null` for a root post. */
  parentId: string | null;
  repo: RepoRef;
  createdAt: number;
  replies: ReplyPointer[];
}

/** The data needed to first materialize a post. */
export interface PostSeed {
  id: string;
  kind: PostKind;
  prompt: string;
  parentId: string | null;
  repo: RepoRef;
}

/**
 * A post is a single Durable Object instance, keyed by its id. It owns one
 * repository and the list of replies/forks branching off it — together the
 * instances form the post graph.
 */
export class Post extends Cloudflare.DurableObject<Post>()(
  "Post",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      let record = (yield* state.storage.get<PostRecord>("post")) ?? null;

      const save = Effect.fn(function* (next: PostRecord) {
        yield* state.storage.put("post", next);
        record = next;
        return next;
      });

      return {
        /**
         * Materialize this post from its seed. Idempotent — if the post already
         * exists (a retried create), the existing record is returned unchanged.
         */
        init: Effect.fn("init")(function* (seed: PostSeed) {
          if (record) return record;
          const createdAt = yield* Effect.sync(() => Date.now());
          return yield* save({ ...seed, createdAt, replies: [] });
        }),

        /** Read the current state of this post, or `null` if uninitialized. */
        snapshot: Effect.fn("snapshot")(function* () {
          return record;
        }),

        /** Append a reply/fork pointer, wiring a new edge into the graph. */
        addReply: Effect.fn("addReply")(function* (reply: ReplyPointer) {
          if (!record) return;
          yield* save({ ...record, replies: [...record.replies, reply] });
        }),
      };
    });
  }),
) {}
