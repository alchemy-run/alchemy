import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * A POST — the company's one message shape, and the only structure
 * the conversation has.
 *
 * Everything is a post in a tree: a human's channel message, an
 * agent's message addressed with `@mentions`, and each mentioned
 * agent's answer. A post REPLIES to exactly one post (`parent`), and
 * a post's replies are its children — arbitrarily deep, uniformly
 * recursive, like a reddit comment or a tweet:
 *
 * ```
 * manager: @reviewer what do you check first? @e-demo1 introduce yourself
 * ├─ reviewer: the diff, then the tests…
 * ├─ e-demo1: @reviewer what do you check first?     ← asked while answering
 * │  └─ reviewer: the diff, then the tests…
 * └─ e-demo1: I'm an engineer on this codebase…
 * ```
 *
 * There is deliberately NO "ask" record. An ask is not an edge with a
 * question and an answer welded together — it is a post that mentions
 * people, and their answers are posts replying to it. That collapse
 * is what lets one recursive renderer draw the whole conversation,
 * and why a target is never named twice (the text addresses it).
 *
 * The store is write-through from the Ask tool's physics (the post
 * lands when it is sent, each reply as it bubbles back), so the tree
 * is live while chains run.
 */
export interface Post {
  readonly id: string;
  /** The post this replies to — absent for a root. */
  readonly parent?: string;
  /** Who wrote it — an agent's name, or the human's. */
  readonly author: string;
  /** The message itself; `@mentions` address whoever it asks. */
  readonly text: string;
  /**
   * `running` — at least one mentioned agent still owes a reply;
   * `settled` — every reply landed; `failed` — the exchange broke
   * (the text of the failing reply carries why).
   */
  readonly status: "running" | "settled" | "failed";
  readonly at: number;
  /** Its replies — nested, oldest first. */
  readonly children: ReadonlyArray<Post>;
}

export class Posts extends Context.Service<
  Posts,
  {
    /** Write a post. Roots omit `parent`. */
    readonly post: (input: {
      readonly id: string;
      readonly parent?: string;
      readonly author: string;
      readonly text: string;
      readonly status?: Post["status"];
    }) => Effect.Effect<void>;
    /** Move a post's status once its replies land (or break). */
    readonly settle: (
      id: string,
      status: Post["status"],
    ) => Effect.Effect<void>;
    /** A post and everything beneath it. */
    readonly tree: (id: string) => Effect.Effect<Post | undefined>;
    /**
     * The chain ABOVE a post — root first, ending with the post
     * itself. The ask chain's structural source: cycle and hop
     * guards walk these authors instead of any in-band header.
     */
    readonly ancestors: (
      id: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly author: string }>
    >;
    /** The newest roots — the company's recent exchanges. */
    readonly roots: (limit?: number) => Effect.Effect<ReadonlyArray<Post>>;
  }
>()("Posts") {}
