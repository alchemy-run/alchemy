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
 * - the GitHub issues and pulls assigned to it (refs + last-known state + the
 *   worktree each PR gets in the thread's one sandbox),
 * - the subagent registry (who is running on whose brief),
 * - the meta the rail shows (name, title, status, turn).
 */

export type Turn = "you" | "agents" | "others" | "idle";

export interface Assignment {
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
  readonly assigned: ReadonlyArray<Assignment>;
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
 * Who is touching the thread's books. The thread's OWN agent already
 * knows what it did (the tool call is in its conversation); everyone
 * else — the channel, the operator, a webhook — is outside the
 * conversation, so the thread tells its agent about the change.
 */
export interface ByOptions {
  /** `"agent"`: the thread's agent is the author — no note is sent
   *  into its conversation. Default: an outsider — the agent is told. */
  readonly by?: "agent";
}

/**
 * THE THREAD, as an object: the one API for everything a thread is —
 * its books (assigned refs, worktrees, agents, members, the rail's meta)
 * AND its agent. Callers never hold the agent: they call the thread,
 * and the thread manipulates its agent — `brief` speaks to it,
 * `assign`/`unassign`/`place`/`noteEvent` update the books and put the
 * fact in the agent's conversation, `agentStop`/`agentResume`/
 * `agentDelete` operate an engineer's session and its row together,
 * `remove` tears the whole thing down. Deterministic verbs; the
 * conversation is the record they write into.
 *
 * Physics: a facade over the per-thread ThreadDO (the books) and the
 * agent's session (addressed by name through `AI.Sessions` — the
 * agent's own Layer depends on this one, so this one must not depend
 * back on it). Every mutation also pushes the channel-side
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
    /**
     * SPEAK to the thread's agent — the brief that starts its work, a
     * steer, the operator's instruction relayed. Wakes it; fire and
     * forget — its work shows up in the thread.
     */
    readonly brief: (id: string, text: string) => Effect.Effect<void>;
    /**
     * TELL the thread's agent something without waking it — context
     * in its inbox, heard at its next sampling. What the books-verbs
     * below use to keep the conversation the record.
     */
    readonly tell: (id: string, input: unknown) => Effect.Effect<void>;
    /**
     * Place channel messages into the thread (tags them in the
     * channel) — and the agent hears them: the operator's real words,
     * with author and time, not a paraphrase of them.
     */
    readonly place: (
      id: string,
      messageIds: ReadonlyArray<string>,
      options?: ByOptions,
    ) => Effect.Effect<ThreadState>;
    /** ASSIGN issues / pull requests to the thread — it governs them
     *  from now on: their events route here; each pull gets a worktree. */
    readonly assign: (
      id: string,
      assigned: ReadonlyArray<{
        readonly ref: string;
        readonly kind: "issue" | "pull";
        readonly title: string;
        readonly state?: string;
      }>,
      options?: ByOptions,
    ) => Effect.Effect<ThreadState>;
    readonly unassign: (
      id: string,
      ref: string,
      options?: ByOptions,
    ) => Effect.Effect<ThreadState>;
    /** A GitHub event for an owned ref: the entity's state converges
     *  and the agent hears the event — context, not a trigger. */
    readonly noteEvent: (
      id: string,
      event: GitHub.RepositoryEvent,
    ) => Effect.Effect<ThreadState>;
    /** Record a worktree on an assigned pull request. */
    readonly setWorktree: (
      id: string,
      ref: string,
      worktree: string,
    ) => Effect.Effect<ThreadState>;
    readonly agentUpsert: (
      id: string,
      row: ThreadAgentRow,
    ) => Effect.Effect<ThreadState>;
    /** Settle an agent's row (state + settledAt) — an update only; a
     *  row deleted by the operator mid-dispatch is not resurrected. */
    readonly agentSettle: (
      id: string,
      key: string,
      state: ThreadAgentRow["state"],
      settledAt: number,
    ) => Effect.Effect<ThreadState>;
    /**
     * STOP an agent: the off switch. Its session settles (the round in
     * flight — a command on the machine — is cut) and the books say
     * stopped. The thread agent's spawn tool, waiting on the dispatch,
     * is answered with the Stopped outcome and records the same.
     * `undefined` when the thread has no such agent.
     */
    readonly agentStop: (
      id: string,
      key: string,
    ) => Effect.Effect<ThreadState | undefined>;
    /**
     * RESUME a stopped (or finished) agent: the tombstone is cleared
     * and the session takes input again — the operator steers it from
     * its pane. Nothing runs until something is said to it.
     */
    readonly agentResume: (
      id: string,
      key: string,
    ) => Effect.Effect<ThreadState | undefined>;
    /** DELETE an agent: its session is erased (round cut, transcript
     *  purged; the thread's machine is shared and stays) and its row
     *  leaves the books. */
    readonly agentDelete: (
      id: string,
      key: string,
    ) => Effect.Effect<ThreadState | undefined>;
    /**
     * The same switches EN MASSE: `keys` names the agents (a
     * selection), or every agent of the thread when omitted. Each is
     * stopped/resumed/deleted as its single verb would — concurrently,
     * a failure on one contained so the rest still land. Answers the
     * books afterwards; `undefined` when there is no such thread.
     */
    readonly agents: (
      id: string,
      verb: "stop" | "resume" | "delete",
      keys?: ReadonlyArray<string>,
    ) => Effect.Effect<ThreadState | undefined>;
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
     * DELETE the thread — everything it is, in THE ORDER: agents
     * first, trees second, the record last.
     *
     * 1. the thread agent's own session — settled, its round cut (a
     *    `spawn` mid-await dies here, so no waiter re-books an agent),
     *    its machine taken down with it;
     * 2. EVERY session descended from it, machine spared (they shared
     *    the thread's): the engineers its agent rows name AND whatever
     *    the session index's parent edges reach beyond them. Each
     *    settles and has its round cut, so an engineer mid-command
     *    stops — before a tree it writes into goes;
     * 3. its pull requests' worktrees on that machine;
     * 4. its DO and every channel projection — the directory row, the
     *    `ref → thread` ownership of its assigned refs, the placed tags on
     *    its members (the channel rows themselves stay; they are the
     *    channel's history). Last, so the thread reads as "deleting"
     *    until everything under it is actually gone.
     *
     * Answers the last snapshot; `undefined` when the thread never
     * existed. Idempotent.
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

/** The `Git.Checkouts` key of a pull request's worktree on a thread's
 *  machine — minted by the thread agent's `worktree` tool, released
 *  when the thread is deleted. */
export const pullWorktreeKey = (threadId: string, number: number): string =>
  `${threadId}--pr-${number}`;

/** Mint a thread id from its name (stable, readable, collision-safe). */
export const mintThreadId = (name: string): string =>
  `t-${name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 32)}-${crypto.randomUUID().slice(0, 8)}`;
