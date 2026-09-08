import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as GitHub from "alchemy/GitHub";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";

/**
 * A THREAD is a task — and a thread IS a session: its conversation is
 * the thread agent's transcript (the driver's session DO, attached
 * over `/attach/Thread/<id>`), never a second chat log. What the
 * ThreadDO holds is everything AROUND the conversation:
 *
 * - the channel messages PLACED into it (the rows stay in the channel,
 *   tagged; the membership lives here),
 * - the GitHub entities it governs (refs + last-known state + the
 *   worktree each PR gets in the thread's one sandbox),
 * - the subagent registry (who is running on whose brief),
 * - the meta the rail shows (name, title, status, turn).
 */

export type Turn = "you" | "agents" | "others" | "idle";

export interface ThreadEntity {
  /** `owner/repo#N`. */
  readonly ref: string;
  readonly kind: "issue" | "pull";
  /** Last-known state (`open`, `closed`, `merged`) — GitHub's word. */
  readonly state: string;
  readonly title: string;
  /** The named worktree in the thread's sandbox, once one exists. */
  readonly worktree?: string;
}

export interface ThreadAgentRow {
  /** The full session key (`t-<id>::<slug>`) — attach/terminal address. */
  readonly key: string;
  readonly kind: "engineer";
  readonly brief: string;
  readonly cwd?: string;
  readonly state: "running" | "done" | "failed" | "stopped";
  readonly startedAt: number;
  readonly settledAt?: number;
}

export interface ThreadState {
  readonly id: string;
  /** Short handle (`do-init`) — the rail's label. */
  readonly name: string;
  /** One line — what the thread is about. */
  readonly title: string;
  readonly status: "open" | "closed";
  readonly turn: Turn;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly entities: ReadonlyArray<ThreadEntity>;
  readonly agents: ReadonlyArray<ThreadAgentRow>;
  /** Channel message ids placed into this thread, oldest first. */
  readonly members: ReadonlyArray<string>;
}

/** What `/thread/:id` pushes: the whole snapshot, it is small. */
export interface ThreadSocketFrame {
  readonly type: "state";
  readonly state: ThreadState;
}

/**
 * The threads, as the rest of the org addresses them — a facade over
 * the per-thread ThreadDOs that ALSO pushes the channel-side
 * projections (directory row, attachment ownership, placed tags,
 * cards). The ThreadDO's storage is truth if a projection disagrees.
 */
export class Threads extends Context.Service<
  Threads,
  {
    readonly create: (input: {
      readonly id?: string;
      readonly name: string;
      readonly title: string;
    }) => Effect.Effect<ThreadState>;
    readonly get: (id: string) => Effect.Effect<ThreadState | undefined>;
    /** Place channel messages into the thread (tags them in the channel). */
    readonly place: (
      id: string,
      messageIds: ReadonlyArray<string>,
    ) => Effect.Effect<ThreadState>;
    readonly attach: (
      id: string,
      entities: ReadonlyArray<{
        readonly ref: string;
        readonly kind: "issue" | "pull";
        readonly title: string;
        readonly state?: string;
      }>,
    ) => Effect.Effect<ThreadState>;
    readonly detach: (id: string, ref: string) => Effect.Effect<ThreadState>;
    /** A GitHub event for an owned ref: update the entity's state. */
    readonly noteEvent: (
      id: string,
      event: GitHub.RepositoryEvent,
    ) => Effect.Effect<ThreadState>;
    /** Record a worktree on an attached entity. */
    readonly setWorktree: (
      id: string,
      ref: string,
      worktree: string,
    ) => Effect.Effect<ThreadState>;
    readonly agentUpsert: (
      id: string,
      row: ThreadAgentRow,
    ) => Effect.Effect<ThreadState>;
    /** A card in the channel, from this thread. */
    readonly postCard: (
      id: string,
      card: {
        readonly title: string;
        readonly text: string;
        readonly review?: {
          readonly owner: string;
          readonly repo: string;
          readonly number: number;
        };
      },
    ) => Effect.Effect<void>;
    readonly rename: (
      id: string,
      input: { readonly name?: string; readonly title?: string },
    ) => Effect.Effect<ThreadState>;
    readonly close: (id: string) => Effect.Effect<ThreadState>;
    /**
     * DELETE the thread: erase its DO and unwind every channel
     * projection — the directory row, the `ref → thread` ownership of
     * its entities, the placed tags on its members (the channel rows
     * themselves stay; they are the channel's history, not the
     * thread's). Answers the last snapshot so the caller can tear down
     * what lives beyond the thread (its agent sessions, its machine);
     * `undefined` when the thread never existed. Idempotent.
     */
    readonly remove: (id: string) => Effect.Effect<ThreadState | undefined>;
    /** Route the `/thread/:id` WebSocket upgrade into the thread's DO. */
    readonly socket: (
      id: string,
      request: HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("alchemy-org/Threads") {}

/** The thread agent's session term — `/attach/Thread/<id>`. */
export const THREAD_TERM = "Thread";

/** Mint a thread id from its name (stable, readable, collision-safe). */
export const mintThreadId = (name: string): string =>
  `t-${name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 32)}-${crypto.randomUUID().slice(0, 8)}`;
