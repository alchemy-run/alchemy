import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * A POST — the company's one message shape.
 *
 * The conversation is a FLAT, chronological list per channel — like a
 * discord channel, not a tree. A human's message, an agent's message
 * addressed with `@mentions`, and each mentioned agent's answer are
 * all posts in the same stream, in the order they happened. Structure
 * is DERIVED, never stored as shape: a post may carry `replyTo` — a
 * reference to the message it answers — and its text carries
 * `@mentions`; readers (the UI, the ask chain guard) parse those
 * references into whatever graph they need.
 *
 * There is deliberately NO tree. Threading, indentation, and lanes
 * were all attempts to make storage carry presentation; they made
 * parallel replies look sequential and deep chains unreadable. The
 * stream is the truth (what happened, in order); `replyTo` is the
 * annotation (what each message answers).
 */
export interface Post {
  readonly id: string;
  /** The message this one answers — a reference, not a tree edge. */
  readonly replyTo?: string;
  /** The channel the message belongs to (`root`, `engineering`). */
  readonly channel?: string;
  /** Who wrote it — an agent's name, or the human's. */
  readonly author: string;
  /** `ask` — the message delegates (its `@mentions` name who it
   *  asks); `message` — an answer or a plain statement. */
  readonly kind: "message" | "ask";
  /** The message itself; `@mentions` address whoever it asks. */
  readonly text: string;
  /**
   * `running` — at least one mentioned agent still owes a reply;
   * `settled` — every reply landed; `failed` — the exchange broke
   * (the text of the failing reply carries why).
   */
  readonly status: "running" | "settled" | "failed";
  /**
   * While `running`, WHO the message is waiting on — the agent the gate
   * routed it to. The UI names them ("engineer is typing…") instead of
   * showing a bare spinner.
   */
  readonly answering?: string;
  /** How the gate routed it — the UI shows a thread shell for
   *  `thread` the moment the message lands, agent typing inside. */
  readonly mode?: "thread" | "inline";
  readonly at: number;
}

export class Posts extends Context.Service<
  Posts,
  {
    /** Write a post into the stream. */
    readonly post: (input: {
      readonly id: string;
      readonly replyTo?: string;
      readonly channel?: string;
      readonly author: string;
      /** @default "message" */
      readonly kind?: Post["kind"];
      readonly text: string;
      readonly status?: Post["status"];
      /** The agent this message is waiting on, while it runs. */
      readonly answering?: string;
      readonly mode?: Post["mode"];
    }) => Effect.Effect<void>;
    /** Persist association edges (upsert on from+to+label). */
    readonly edgesAdd: (
      rows: ReadonlyArray<{
        from: string;
        to: string;
        label: string;
        confidence: number;
        provenance: string;
      }>,
    ) => Effect.Effect<void>;
    /** Every edge touching a post, either direction. */
    readonly edgesOf: (id: string) => Effect.Effect<
      ReadonlyArray<{
        from: string;
        to: string;
        label: string;
        confidence: number;
        provenance: string;
      }>
    >;
    /** Stamp the routing outcome once the gate decides. */
    readonly route: (
      id: string,
      answering: string,
      mode: NonNullable<Post["mode"]>,
      /** A JUDGED reply edge — stamped when the gate is sure the
       *  message piles onto an earlier one. */
      replyTo?: string,
    ) => Effect.Effect<void>;
    /** Move a post's status once its replies land (or break). */
    readonly settle: (
      id: string,
      status: Post["status"],
    ) => Effect.Effect<void>;
    /** One post. */
    readonly get: (id: string) => Effect.Effect<Post | undefined>;
    /** The messages that reply to one post, oldest first. */
    readonly replies: (id: string) => Effect.Effect<ReadonlyArray<Post>>;
    /**
     * The reference chain ABOVE a post — full messages, following
     * `replyTo`, oldest first, ending with the post itself. The ask
     * chain's structural source (cycle and hop guards walk the
     * authors) and the explorer's way UP the graph.
     */
    readonly ancestors: (id: string) => Effect.Effect<ReadonlyArray<Post>>;
    /** The whole THREAD a post lives in — its root's reply graph,
     *  chronological, root first. The explorer's widest view. */
    readonly thread: (id: string) => Effect.Effect<ReadonlyArray<Post>>;
    /** The stream, oldest first — one channel's feed when `channel`
     *  is given. `limit` keeps the newest messages. */
    readonly list: (options?: {
      readonly channel?: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<Post>>;
    /**
     * WORKSPACE ↔ THREAD links. There is no per-session default:
     * agents create workspaces as they need them; creating one inside
     * a thread links it there, and any agent can query the thread's
     * active set to find its footing.
     */
    readonly linkWorkspace: (
      thread: string,
      workspace: string,
    ) => Effect.Effect<void>;
    readonly workspacesOf: (
      thread: string,
    ) => Effect.Effect<ReadonlyArray<string>>;
    /** A dropped workspace leaves every thread it was linked in. */
    readonly unlinkWorkspace: (workspace: string) => Effect.Effect<void>;
  }
>()("Posts") {}
