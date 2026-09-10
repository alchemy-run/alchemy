import type * as AI from "alchemy/AI";
import type * as GitHub from "alchemy/GitHub";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Channel, type ChannelMessage } from "../channel/Channel.ts";
import { ThreadAgent } from "./ThreadAgent.ts";

/**
 * A THREAD is a task — and a thread IS a session: its conversation is
 * the thread agent's transcript (the driver's session DO, attached
 * over `/attach/Thread/<id>`), never a second chat log. Its BOOKS —
 * the same session's persistent state (`ThreadAgent.ts`) — are
 * everything AROUND the conversation:
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

export interface Subagent {
  /** The full session key (`t-<id>::<slug>`) — attach/terminal address. */
  readonly key: string;
  readonly kind: "engineer";
  readonly brief: string;
  readonly cwd?: string;
  readonly state: "running" | "done" | "failed" | "stopped";
  readonly startedAt: number;
  readonly settledAt?: number;
}

/**
 * The thread that kicked off a subagent session, from its key: an
 * engineer a thread spawned is keyed `<thread>::e-<id>`
 * (ThreadAgent.spawn). A standalone session (`owner/repo/name`)
 * belongs to none.
 */
export const threadOf = (sessionKey: string): string | undefined => {
  const at = sessionKey.indexOf("::");
  return at >= 0 ? sessionKey.slice(0, at) : undefined;
};

export interface ThreadState {
  readonly id: string;
  /** Short handle (`do-init`) — the rail's label. */
  readonly name: string;
  /** One line — what the thread is about. */
  readonly title: string;
  readonly status: "open" | "closed";
  readonly turn: Turn;
  /** The model this thread's agents sample with — a catalog id
   *  (`platform/Model.ts`); absent = the org's default. The thread
   *  agent and its engineers read it before every sampling. */
  readonly model?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly assigned: ReadonlyArray<Assignment>;
  readonly agents: ReadonlyArray<Subagent>;
  /** Channel message ids placed into this thread, oldest first. */
  readonly members: ReadonlyArray<string>;
}

/** What `/thread/:id` pushes (`AI.Thread.publish` from inside the
 *  thread): the whole snapshot, it is small. */
export interface ThreadSocketFrame {
  readonly type: "state";
  readonly state: ThreadState;
}

/**
 * THE THREAD, from OUTSIDE: the one API the channel, the routes and
 * the webhooks use for everything a thread is — its state (assigned
 * refs, worktrees, agents, members, the rail's meta) AND its agent.
 * Callers never hold the agent: they call the thread, and the thread
 * manipulates its agent — `brief` speaks to it, `assign`/`unassign`/
 * `place`/`noteEvent` update the state and put the fact in the agent's
 * conversation, `agentStop`/`agentResume`/`agentDelete` operate an
 * engineer's session and its record together, `remove` tears the whole
 * thing down. Deterministic verbs; the conversation is the record they
 * write into.
 *
 * Physics: a thin facade over the thread OBJECT — `ThreadAgent.at(id)`
 * (ThreadAgent.ts), whose methods own the state, its push to
 * `/thread/:id` and the channel projections. What the facade adds is
 * the outsider's duty: telling the thread's agent what changed (its
 * own tools skip that — the tool call is already in its conversation).
 */
export class Threads extends Context.Service<
  Threads,
  {
    readonly create: (input: {
      readonly id?: string;
      readonly name: string;
      readonly title: string;
      /** The catalog id its agents sample with; absent = the default. */
      readonly model?: string;
    }) => Effect.Effect<ThreadState, never, RuntimeContext>;
    readonly get: (
      id: string,
    ) => Effect.Effect<ThreadState | undefined, never, RuntimeContext>;
    /**
     * SPEAK to the thread's agent — the brief that starts its work, a
     * steer, the operator's instruction relayed. Wakes it; fire and
     * forget — its work shows up in the thread.
     */
    readonly brief: (
      id: string,
      text: string,
    ) => Effect.Effect<void, never, RuntimeContext>;
    /**
     * TELL the thread's agent something without waking it — context
     * in its inbox, heard at its next sampling. What the state verbs
     * below use to keep the conversation the record.
     */
    readonly tell: (
      id: string,
      input: unknown,
    ) => Effect.Effect<void, never, RuntimeContext>;
    /**
     * Place channel messages into the thread (tags them in the
     * channel) — and the agent hears them: the operator's real words,
     * with author and time, not a paraphrase of them.
     */
    readonly place: (
      id: string,
      messageIds: ReadonlyArray<string>,
    ) => Effect.Effect<ThreadState, never, RuntimeContext>;
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
    ) => Effect.Effect<ThreadState, never, RuntimeContext>;
    readonly unassign: (
      id: string,
      ref: string,
    ) => Effect.Effect<ThreadState, never, RuntimeContext>;
    /** A GitHub event for an owned ref: the entity's state converges
     *  and the agent hears the event — context, not a trigger. */
    readonly noteEvent: (
      id: string,
      event: GitHub.RepositoryEvent,
    ) => Effect.Effect<ThreadState, never, RuntimeContext>;
    /**
     * STOP an agent: the off switch. Its session settles (the round in
     * flight — a command on the machine — is cut) and the state says
     * stopped. The thread agent's spawn tool, waiting on the dispatch,
     * is answered with the Stopped outcome and records the same.
     * `undefined` when the thread has no such agent.
     */
    readonly agentStop: (
      id: string,
      key: string,
    ) => Effect.Effect<ThreadState | undefined, never, RuntimeContext>;
    /**
     * RESUME a stopped (or finished) agent: the tombstone is cleared
     * and the session takes input again — the operator steers it from
     * its pane. Nothing runs until something is said to it.
     */
    readonly agentResume: (
      id: string,
      key: string,
    ) => Effect.Effect<ThreadState | undefined, never, RuntimeContext>;
    /** DELETE an agent: its session is erased (round cut, transcript
     *  purged; the thread's machine is shared and stays) and it
     *  leaves the state. */
    readonly agentDelete: (
      id: string,
      key: string,
    ) => Effect.Effect<ThreadState | undefined, never, RuntimeContext>;
    /**
     * The same switches EN MASSE: `keys` names the agents (a
     * selection), or every agent of the thread when omitted. Each is
     * stopped/resumed/deleted as its single verb would — concurrently,
     * a failure on one contained so the rest still land. Answers the
     * state afterwards; `undefined` when there is no such thread.
     */
    readonly agents: (
      id: string,
      verb: "stop" | "resume" | "delete",
      keys?: ReadonlyArray<string>,
    ) => Effect.Effect<ThreadState | undefined, never, RuntimeContext>;
    readonly rename: (
      id: string,
      input: { readonly name?: string; readonly title?: string },
    ) => Effect.Effect<ThreadState, never, RuntimeContext>;
    /**
     * Choose the model the thread's agents sample with — `undefined`
     * returns to the org's default. Takes effect at the next
     * sampling of each agent (the thread's own and its engineers);
     * nothing in flight is interrupted.
     */
    readonly setModel: (
      id: string,
      model: string | undefined,
    ) => Effect.Effect<ThreadState, never, RuntimeContext>;
    readonly close: (
      id: string,
    ) => Effect.Effect<ThreadState, never, RuntimeContext>;
    /**
     * DELETE the thread — everything it is, in THE ORDER: agents
     * first, trees second, the record last.
     *
     * 1. the thread agent's own session — settled, its round cut (a
     *    `spawn` mid-await dies here, so no waiter re-records an agent);
     * 2. from INSIDE the thread (`ThreadAgent.teardown`): EVERY
     *    session descended from it, machine spared (they shared the
     *    thread's) — the engineers its subagents name AND whatever the
     *    session index's parent edges reach beyond them, each settled
     *    and its round cut, so an engineer mid-command stops before a
     *    tree it writes into goes; then its pull requests' worktrees on
     *    that machine; then every channel projection — the directory
     *    row, the `ref → thread` ownership of its assigned refs, the
     *    placed tags on its members (the channel rows themselves stay;
     *    they are the channel's history) — and the state;
     * 3. the session itself, machine and all. Last, so the thread
     *    reads as "deleting" until everything under it is actually
     *    gone.
     *
     * Answers the last snapshot; `undefined` when the thread never
     * existed. Idempotent.
     */
    readonly remove: (
      id: string,
    ) => Effect.Effect<ThreadState | undefined, never, RuntimeContext>;
  }
>()("alchemy-org/Threads") {}

export { THREAD_TERM } from "./ThreadAgent.ts";

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

/** A placed channel message, as the thread's agent hears it. */
const quote = (message: ChannelMessage): string =>
  `[channel] ${message.author?.login ?? message.kind} · ${new Date(
    message.at,
  ).toISOString()}\n${message.text}`;

/**
 * The {@link Threads} facade over the thread object: every verb is
 * `ThreadAgent.at(id)` — the method on the state — followed by what
 * only an OUTSIDER does: telling the thread's agent what just changed
 * (its own tools skip that; the tool call is already in its
 * conversation). `remove` is the one composite: stop, tear down from
 * inside, then erase the session itself.
 */
export const ThreadsLive: Layer.Layer<
  Threads,
  never,
  ThreadAgent | Channel | AI.Sessions
> = Layer.effect(
  Threads,
  Effect.gen(function* () {
    const agent = yield* ThreadAgent;
    const channel = yield* Channel;
    // a delivery that fails must never cost the caller its state
    // write (already committed) — logged, contained
    const tell = (id: string, input: unknown) =>
      agent
        .at(id)
        .send(input, { wake: false })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`thread ${id}: telling the agent failed`, cause),
          ),
        );

    return Threads.of({
      create: (input) =>
        agent.at(input.id ?? crypto.randomUUID()).create({
          name: input.name,
          title: input.title,
          ...(input.model === undefined ? {} : { model: input.model }),
        }),
      get: (id) => agent.at(id).state(),
      brief: (id, text) => agent.at(id).send(text),
      tell,
      place: Effect.fn(function* (id, messageIds) {
        const snap = yield* agent.at(id).place(messageIds);
        if (messageIds.length > 0) {
          // the rows themselves, oldest first — the operator's words
          // reach the agent as said, not as the channel summarized them
          const rows = yield* channel.read(messageIds);
          yield* Effect.forEach(
            [...rows].sort((a, b) => a.seq - b.seq),
            (row) => tell(id, quote(row)),
            { discard: true },
          );
        }
        return snap;
      }),
      assign: Effect.fn(function* (id, items) {
        const snap = yield* agent.at(id).assign(items);
        // the conversation is the record, and this assignment
        // happened OUTSIDE it — without this the agent opens on a
        // brief saying "#1521" with no trace that #1521 is assigned
        yield* Effect.forEach(
          items,
          (entity) =>
            tell(
              id,
              `[assigned] ${entity.ref} — ${entity.kind}${
                entity.state === undefined ? "" : `, ${entity.state}`
              } — ${entity.title}`,
            ),
          { discard: true },
        );
        return snap;
      }),
      unassign: Effect.fn(function* (id, ref) {
        const snap = yield* agent.at(id).unassign(ref);
        yield* tell(id, `[unassigned] ${ref}`);
        return snap;
      }),
      noteEvent: Effect.fn(function* (id, event) {
        const snap = yield* agent.at(id).noteEvent(event);
        // the agent hears the event as non-waking input — context,
        // not a trigger; it reads it at its next wake
        yield* tell(id, event);
        return snap;
      }),
      agentStop: (id, key) => agent.at(id).agentStop(key),
      agentResume: (id, key) => agent.at(id).agentResume(key),
      agentDelete: (id, key) => agent.at(id).agentDelete(key),
      agents: (id, verb, keys) => agent.at(id).agents(verb, keys),
      rename: (id, input) => agent.at(id).rename(input),
      setModel: (id, model) => agent.at(id).setModel(model),
      close: (id) => agent.at(id).close(),
      remove: Effect.fn(function* (id) {
        // 1. the thread's own agent: settled, its round cut (a
        // `spawn` mid-await dies here, so no waiter re-records an
        // agent); the object stays for step 2
        yield* agent.at(id).stop();
        // 2. everything under it, from inside — the machine is
        // still up for the worktrees
        const snap = yield* agent.at(id).teardown();
        // 3. the session itself, machine and all — last, so the
        // thread reads as "deleting" until everything under it is
        // actually gone
        yield* agent.at(id).destroy();
        return snap;
      }),
    });
  }),
);
