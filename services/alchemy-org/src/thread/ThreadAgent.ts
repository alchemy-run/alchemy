import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import type * as GitHub from "alchemy/GitHub";
import * as PersistentRef from "alchemy/PersistentRef";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as S from "effect/Schema";
import { Channel, parseEntityRef, refOf } from "../channel/Channel.ts";
import { Engineer } from "../coding/Engineer.ts";
import { BadRef, makeEntityLookup } from "../github/Entity.ts";
import { connected, nameOf, primary } from "../github/Repos.ts";
import { SessionRepo } from "../github/SessionRepo.ts";
import { models } from "../platform/Model.ts";
import { Message } from "./Message.ts";
import { THREAD_TERM } from "./Terms.ts";
import {
  pullWorktreeKey,
  type Assignment,
  type Subagent,
  type ThreadState,
  type Turn,
} from "./Threads.ts";

/** The thread agent's session term — `/attach/Thread/<id>`. */
export { THREAD_TERM } from "./Terms.ts";

/**
 * The THREAD — one durable session per thread (`t-<id>`), the task's
 * whole life, as an OBJECT: its conversation IS this session's
 * transcript, its `ThreadState` IS this session's state, and its API
 * is the one way anyone outside touches either.
 *
 * The state is everything AROUND the conversation — the channel
 * messages placed into it, the issues and pulls assigned to it (with
 * the worktree each pull gets on the thread's one machine), the
 * engineers it kicked off, the meta the rail shows (name, title,
 * status, turn, model). It lives in a `PersistentRef` on the session
 * (Durable Object storage on Cloudflare); every mutation is a method
 * that rewrites it, PUSHES the fresh state to whoever is attached
 * (`/thread/:id` — it is small, push it whole) and projects the
 * change into the channel (directory row, attachment ownership).
 *
 * The agent's own tools call the very same methods, in-process — the
 * conversation is the record they write into. Callers outside reach
 * them over `ThreadAgent.at(id)`, from wherever the session actually
 * runs.
 *
 * Its engineers act on GitHub DIRECTLY: they push to the pull
 * requests the thread governs and open new ones to solve issues —
 * there is no approval gate.
 */
export class ThreadAgent extends AI.Agent<ThreadAgent, ThreadApi>(import.meta)(
  THREAD_TERM,
) {}

/** What is written to create a thread; the rest of the state starts
 *  empty. */
export interface CreateThread {
  /** Short handle (`do-init`) — the rail's label. */
  readonly name: string;
  /** One line — what the thread is about. */
  readonly title: string;
  /** The catalog id its agents sample with; absent = the default. */
  readonly model?: string;
}

/**
 * The thread's METHODS — what `ThreadAgent.at(id)` answers. Every
 * mutation returns the fresh state; one on a thread that was never
 * `create`d is a defect (there is no state to write).
 */
export interface ThreadApi {
  /** Write the initial state. Idempotent: an existing thread keeps
   *  its own (the caller's name/title are ignored). */
  readonly create: (input: CreateThread) => Effect.Effect<ThreadState>;
  /** The state; `undefined` when the thread was never created. */
  readonly state: () => Effect.Effect<ThreadState | undefined>;
  /** Place channel messages (the channel tags them; the membership
   *  lives here). */
  readonly place: (ids: ReadonlyArray<string>) => Effect.Effect<ThreadState>;
  /** ASSIGN issues / pull requests — the thread governs them from now
   *  on: their events route here; the channel's ownership follows. */
  readonly assign: (
    assigned: ReadonlyArray<{
      readonly ref: string;
      readonly kind: "issue" | "pull";
      readonly title: string;
      readonly state?: string;
    }>,
  ) => Effect.Effect<ThreadState>;
  readonly unassign: (ref: string) => Effect.Effect<ThreadState>;
  /** A GitHub event for an owned ref: the entity's state converges. */
  readonly noteEvent: (
    event: GitHub.RepositoryEvent,
  ) => Effect.Effect<ThreadState>;
  /** Record a worktree on an assigned pull request. */
  readonly setWorktree: (
    ref: string,
    worktree: string,
  ) => Effect.Effect<ThreadState>;
  /**
   * STOP an engineer: the off switch. Its session settles (the round
   * in flight — a command on the machine — is cut) and the state says
   * stopped. `undefined` when the thread has no such agent.
   */
  readonly agentStop: (key: string) => Effect.Effect<ThreadState | undefined>;
  /** RESUME a stopped engineer: the tombstone is cleared and the
   *  engineer PICKS ITS WORK BACK UP — it runs a round over its thread
   *  as it stands (the stop landed the cut calls, answered as
   *  interrupted), no input needed. An engineer whose work had already
   *  finished only takes input again — steer it from its prompt. */
  readonly agentResume: (key: string) => Effect.Effect<ThreadState | undefined>;
  /** DELETE an engineer: its session is erased (round cut, transcript
   *  purged; the thread's machine is shared and stays) and it
   *  leaves the state. */
  readonly agentDelete: (key: string) => Effect.Effect<ThreadState | undefined>;
  /** The switches EN MASSE: `keys` names the agents, or every agent
   *  of the thread when omitted; a failure on one is contained. */
  readonly agents: (
    verb: "stop" | "resume" | "delete",
    keys?: ReadonlyArray<string>,
  ) => Effect.Effect<ThreadState | undefined>;
  readonly rename: (input: {
    readonly name?: string;
    readonly title?: string;
  }) => Effect.Effect<ThreadState>;
  /**
   * Choose the model the thread's agents sample with — `undefined`
   * returns to the org's default. The thread's own agent reads it
   * before every sampling; the engineers still running are told
   * (`Engineer.setModel`). Nothing in flight is interrupted.
   */
  readonly setModel: (model: string | undefined) => Effect.Effect<ThreadState>;
  readonly close: () => Effect.Effect<ThreadState>;
  /**
   * Everything UNDER the thread, gone — the part of a delete that runs
   * inside the thread (its machine is still up): every engineer and
   * every session descended from it (machines spared — they shared
   * this one), the pull requests' worktrees, the channel projections
   * (directory row, `ref → thread` ownership, placed tags). The state
   * is wiped last. The session itself is the caller's to destroy
   * afterwards — an object cannot erase itself from inside a method.
   * Answers the last state; `undefined` when the thread never
   * existed. Idempotent.
   */
  readonly teardown: () => Effect.Effect<ThreadState | undefined>;
}

/* ── the state ──────────────────────────────────────────────────── */

/** `turn` is DERIVED from the rest — recomputed on every commit, never
 *  written by a caller. */
const turnOf = (state: ThreadState): Turn =>
  state.status === "closed"
    ? "idle"
    : state.agents.some((a) => a.state === "running")
      ? "agents"
      : state.assigned.some((e) => e.state === "open")
        ? "others"
        : "idle";

/** A thread as the channel's directory lists it. */
const directoryOf = (state: ThreadState) => ({
  id: state.id,
  name: state.name,
  title: state.title,
  status: state.status,
  turn: state.turn,
  updatedAt: state.updatedAt,
});

/** The engineers' session term — the thread's subagents are its keys. */
const engineerTerm = Engineer["~alchemy/Name"];

/* ── vocabulary ─────────────────────────────────────────────────── */

const ref = AI.Thing("ref", S.String)`
  A GitHub entity, fully qualified — "owner/repo#832".`;

const kind = AI.Thing("kind", S.Literals(["issue", "pull"]))`
  What the ref is: "issue" or "pull".`;

const entityTitle = AI.Thing("title", S.String)`
  The entity's title, as GitHub has it.`;

const brief = AI.Thing("brief", S.String)`
  The engineer's whole world: what to do, what "done" looks like, what
  to avoid. Where it works is the pull argument, not prose.`;

const pull = AI.Thing("pull", S.optionalKey(S.String))`
  The assigned pull request — "owner/repo#N" — whose worktree the
  engineer is rooted in. Omit only for work that belongs to no pull
  request yet (the engineer then starts in the machine's default tree
  and opens a new pull request).`;

const cardTitle = AI.Thing("title", S.String)`
  The card's one-line headline — what the operator reads in the channel.`;

const text = AI.Thing("text", S.String)`
  The text, complete and self-contained. Markdown.`;

const why = AI.Thing("why", S.String)`
  One or two sentences of justification the operator can check.`;

const path = AI.Thing("path", S.String)`
  The worktree's absolute path on this thread's machine.`;

const branch = AI.Thing("branch", S.String)`
  The branch the worktree has checked out.`;

const agentKey = AI.Thing("agent", S.String)`
  The subagent's session key — its address for attach/terminal.`;

const report = AI.Thing("report", S.String)`
  The subagent's settled outcome, verbatim (clipped).`;

const state = AI.Thing(
  "state",
  S.Struct({
    id: S.String,
    name: S.String,
    title: S.String,
    status: S.Literals(["open", "closed"]),
    turn: S.Literals(["you", "agents", "others", "idle"]),
    assigned: S.Array(
      S.Struct({
        ref: S.String,
        kind: S.Literals(["issue", "pull"]),
        state: S.String,
        title: S.String,
        worktree: S.optionalKey(S.String),
      }),
    ),
    agents: S.Array(
      S.Struct({
        key: S.String,
        kind: S.String,
        brief: S.String,
        cwd: S.optionalKey(S.String),
        state: S.Literals(["running", "done", "failed", "stopped"]),
      }),
    ),
  }),
)`
  This thread's full state: meta (name, title, status, whose turn), the
  issues and pulls assigned to it (with their worktrees), and its subagents.`;

/* ── declared failures ──────────────────────────────────────────── */

class NotAssigned extends Data.TaggedError("NotAssigned")<{
  message: string;
}> {}
class CheckoutFailed extends Data.TaggedError("CheckoutFailed")<{
  message: string;
}> {}

/** A short unique suffix for subagent session keys. */
const shortId = (): string => crypto.randomUUID().slice(0, 8);

export const ThreadAgentLive = ThreadAgent.make(
  Effect.gen(function* () {
    // ── the CHARTER: one Effect, run once where the Layer builds. The
    // org around the thread — its channel, the session gateway, the
    // engineers, the catalog — and the tools below are the agent's,
    // shared by every thread. There is no thread here: each method and
    // tool reads the one it acts for from the frame (`AI.Thread`), and
    // the state is a DECLARED cell that resolves to that thread's row.
    const channel = yield* Channel;
    const sessions = yield* AI.Sessions;
    const sessionRepo = yield* SessionRepo;
    const checkouts = yield* Git.Checkouts;
    const engineer = yield* Engineer;
    const getModel = yield* models;
    // an assignment is VERIFIED against GitHub, never taken on the model's word
    const lookup = yield* makeEntityLookup;

    // the connected repositories are static code (Repos.ts) — constant
    // for the deploy, so they belong in the stance
    const primaryName = nameOf(primary);
    const repoNames = connected
      .map((entry) => nameOf(entry.repository))
      .join(", ");

    // the thread a method or tool acts for — its id, from the frame
    const self = Effect.map(AI.Thread, (thread) => thread.key);

    // ── the STATE: one durable cell per thread, `null` until `create`
    const threadState = PersistentRef.of<ThreadState | null>(
      "state",
      () => null,
    );

    const current = Effect.gen(function* () {
      const found = yield* threadState;
      if (found !== null) return found;
      const id = yield* self;
      return yield* Effect.die(`thread ${id}: the state was never created`);
    });

    /** Every mutation ends here: rewrite, bump, derive, push, project. */
    const commit = Effect.fn(function* (
      f: (state: ThreadState) => ThreadState,
    ) {
      const thread = yield* AI.Thread;
      const before = yield* current;
      const bumped = { ...f(before), updatedAt: Date.now() };
      const next: ThreadState = { ...bumped, turn: turnOf(bumped) };
      yield* PersistentRef.set(threadState, next);
      yield* thread.publish(next);
      yield* channel.directoryUpsert(directoryOf(next));
      return next;
    });

    const subagent = (key: string) =>
      Effect.map(threadState, (found) =>
        found?.agents.find((agent) => agent.key === key),
      );

    const upsertAgent = (agent: Subagent) =>
      commit((b) => ({
        ...b,
        agents: [...b.agents.filter((a) => a.key !== agent.key), agent].sort(
          (x, y) => x.startedAt - y.startedAt,
        ),
      }));

    // ── the single switches on one engineer: its session over its
    // stub (a cross-DO call on Cloudflare) and its record together
    const stopAgent = Effect.fn(function* (key: string) {
      const agent = yield* subagent(key);
      if (agent === undefined) return undefined;
      yield* engineer.at(key).stop();
      return yield* upsertAgent({
        ...agent,
        state: "stopped",
        settledAt: Date.now(),
      });
    });
    const resumeAgent = Effect.fn(function* (key: string) {
      const agent = yield* subagent(key);
      if (agent === undefined) return undefined;
      yield* engineer.at(key).resume();
      const { settledAt: _settled, ...rest } = agent;
      return yield* upsertAgent({ ...rest, state: "running" });
    });
    const deleteAgent = Effect.fn(function* (key: string) {
      const agent = yield* subagent(key);
      if (agent === undefined) return undefined;
      // the thread's machine is shared — it stays
      yield* engineer.at(key).destroy({ machine: false });
      return yield* commit((b) => ({
        ...b,
        agents: b.agents.filter((a) => a.key !== key),
      }));
    });
    const snapshot = Effect.map(threadState, (found) => found ?? undefined);

    // ── the METHODS — checked against the contract by `make` where
    // the object below names them; the frame in `R` is the driver's
    // business
    const create = Effect.fn(function* (input: CreateThread) {
      const existing = yield* threadState;
      if (existing === null) {
        const id = yield* self;
        const now = Date.now();
        yield* PersistentRef.set(threadState, {
          id,
          name: input.name,
          title: input.title,
          status: "open",
          turn: "idle",
          ...(input.model === undefined ? {} : { model: input.model }),
          createdAt: now,
          updatedAt: now,
          assigned: [],
          agents: [],
          members: [],
        });
      }
      return yield* commit((b) => b);
    });

    const getState = () => snapshot;

    const place = Effect.fn(function* (ids: ReadonlyArray<string>) {
      const snap = yield* commit((b) => ({
        ...b,
        members: [...b.members, ...ids.filter((m) => !b.members.includes(m))],
      }));
      yield* channel.tag(ids, yield* self, true);
      return snap;
    });

    const assignEntities = Effect.fn(function* (
      items: ReadonlyArray<{
        readonly ref: string;
        readonly kind: "issue" | "pull";
        readonly title: string;
        readonly state?: string;
      }>,
    ) {
      const snap = yield* commit((b) => {
        const assigned = [...b.assigned];
        for (const entity of items) {
          const row: Assignment = {
            ref: entity.ref,
            kind: entity.kind,
            state: entity.state ?? "open",
            title: entity.title,
          };
          const at = assigned.findIndex((e) => e.ref === entity.ref);
          if (at >= 0) {
            const kept = assigned[at]!;
            assigned[at] = {
              ...row,
              ...(kept.worktree === undefined
                ? {}
                : { worktree: kept.worktree }),
            };
          } else {
            assigned.push(row);
          }
        }
        assigned.sort((x, y) => x.ref.localeCompare(y.ref));
        return { ...b, assigned };
      });
      const id = yield* self;
      yield* Effect.forEach(
        items,
        (entity) => channel.attachmentsSet(entity.ref, id),
        { discard: true },
      );
      return snap;
    });

    const unassignEntity = Effect.fn(function* (ref: string) {
      const snap = yield* commit((b) => ({
        ...b,
        assigned: b.assigned.filter((e) => e.ref !== ref),
      }));
      yield* channel.attachmentsSet(ref, null);
      return snap;
    });

    const noteEvent = (event: GitHub.RepositoryEvent) => {
      const ref =
        event._tag === "Push"
          ? undefined
          : "issue" in event
            ? refOf(
                `${event.repository.owner.login}/${event.repository.name}`,
                event.issue.number,
              )
            : refOf(
                `${event.repository.owner.login}/${event.repository.name}`,
                event.pullRequest.number,
              );
      const next =
        event._tag === "PullRequestMerged"
          ? "merged"
          : event._tag === "PullRequestClosed" || event._tag === "IssueClosed"
            ? "closed"
            : event._tag === "PullRequestOpened" || event._tag === "IssueOpened"
              ? "open"
              : undefined;
      return commit((b) =>
        ref === undefined || next === undefined
          ? b
          : {
              ...b,
              assigned: b.assigned.map((e) =>
                e.ref === ref ? { ...e, state: next } : e,
              ),
            },
      );
    };

    const setWorktree = (ref: string, worktree: string) =>
      commit((b) => ({
        ...b,
        assigned: b.assigned.map((e) =>
          e.ref === ref ? { ...e, worktree } : e,
        ),
      }));

    const switchAgents = Effect.fn(function* (
      verb: "stop" | "resume" | "delete",
      keys?: ReadonlyArray<string>,
    ) {
      const before = yield* threadState;
      if (before === null) return undefined;
      const id = yield* self;
      const chosen =
        keys === undefined
          ? before.agents
          : before.agents.filter((agent) => keys.includes(agent.key));
      // the single verbs, each contained: one agent's session
      // refusing must not leave the others running
      const one = (key: string) =>
        (verb === "stop"
          ? stopAgent(key)
          : verb === "resume"
            ? resumeAgent(key)
            : deleteAgent(key)
        ).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `thread '${id}': ${verb} of agent '${key}' failed (contained)`,
              cause,
            ),
          ),
        );
      yield* Effect.forEach(chosen, (agent) => one(agent.key), {
        discard: true,
        concurrency: 8,
      });
      return yield* snapshot;
    });

    const rename = (input: {
      readonly name?: string;
      readonly title?: string;
    }) =>
      commit((b) => ({
        ...b,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.title === undefined ? {} : { title: input.title }),
      }));

    const setModel = Effect.fn(function* (next: string | undefined) {
      const snap = yield* commit((b) => {
        const { model: _model, ...rest } = b;
        return next === undefined ? rest : { ...rest, model: next };
      });
      // the engineers still running sample with the thread's pick
      // too — each told over its stub, a refusal contained
      const id = yield* self;
      yield* Effect.forEach(
        snap.agents.filter((a) => a.state === "running"),
        (a) =>
          engineer
            .at(a.key)
            .setModel(next)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `thread '${id}': relaying the model to '${a.key}' failed (contained)`,
                  cause,
                ),
              ),
            ),
        { discard: true, concurrency: 8 },
      );
      return snap;
    });

    const close = () => commit((b) => ({ ...b, status: "closed" }));

    const teardown = Effect.fn(function* () {
      const before = yield* threadState;
      const id = yield* self;
      if (before === null) {
        // No state — the thread never existed, or its state was lost
        // (created under an earlier storage layout). The channel may
        // still project it (a directory row, held refs): those are
        // the thread's and go with it, or the row haunts the rail as
        // a thread that cannot be opened OR deleted.
        yield* channel.directoryRemove(id);
        return undefined;
      }
      // 1. every session descended from the thread — its
      // subagents, then the index's parent edges walked transitively
      // from the thread's session (a directory: a stale or
      // absent index only means fewer rows here, never a wrong
      // one). Anonymous `spawn-*` workers are skipped: they ran
      // inside their spawner's round and died with it.
      const descendants = new Map<string, { term: string; key: string }>();
      for (const agent of before.agents) {
        descendants.set(AI.sessionId(engineerTerm, agent.key), {
          term: engineerTerm,
          key: agent.key,
        });
      }
      const listed = yield* sessions.list();
      const frontier = [AI.sessionId(THREAD_TERM, id), ...descendants.keys()];
      while (frontier.length > 0) {
        const parent = frontier.pop()!;
        for (const row of listed) {
          if (
            row.parent !== parent ||
            descendants.has(row.id) ||
            row.key.startsWith("spawn-")
          ) {
            continue;
          }
          descendants.set(row.id, { term: row.term, key: row.key });
          frontier.push(row.id);
        }
      }
      // machines spared: they shared this thread's, which the
      // caller takes down with the thread's own session
      yield* Effect.forEach(
        descendants.values(),
        ({ term, key }) => sessions.remove(term, key, { machine: false }),
        { discard: true, concurrency: 8 },
      );
      // 2. the pull requests' worktrees on this machine — git
      // over the thread's own sandbox, from inside the thread
      yield* Effect.forEach(
        before.assigned.flatMap((entity) => {
          const parsed = parseEntityRef(entity.ref);
          return entity.worktree === undefined ||
            entity.worktree === "." ||
            entity.worktree === "" ||
            parsed === undefined
            ? []
            : [pullWorktreeKey(id, parsed.number)];
        }),
        (key) =>
          checkouts
            .release(key)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `deleting thread '${id}': dropping worktree '${key}' failed (contained): ${error.message}`,
                ),
              ),
            ),
        { discard: true },
      );
      // 3. the channel projections (directoryRemove also frees
      // every attachment the thread held), then the state
      if (before.members.length > 0) {
        yield* channel.tag(before.members, null, false);
      }
      yield* channel.directoryRemove(id);
      yield* PersistentRef.set(threadState, null);
      return before;
    });

    // ── the TOOLS: the agent's hands on its own state — the same
    // methods, called in-process; the tool call in the conversation
    // is the record, so nothing is told back to the agent
    const assign = yield* AI.Tool("assign")`
      Assign ${ref} to this thread — you govern it from now on: its
      events arrive here, closing the thread settles it. The ref is
      looked up on GitHub; answers ${AI.out(kind, entityTitle)} as
      GitHub has them. Fails with ${BadRef} when the ref is not
      "owner/repo#N", names a repository that is not connected, or
      does not exist — copy refs from the channel's links, never
      derive them from an author's login.`(
      Effect.fn(function* (p: { ref: string }) {
        const entity = yield* lookup(p.ref);
        yield* assignEntities([entity]);
        return { kind: entity.kind, title: entity.title };
      }),
    );

    const unassign = yield* AI.Tool("unassign")`
      Unassign ${ref} from this thread — its events stop arriving; the
      issue or pull request itself is untouched.`(
      Effect.fn(function* (p: { ref: string }) {
        yield* unassignEntity(p.ref);
      }),
    );

    /** The thread's worktree for an assigned pull request — made or
     *  found (`Git.Checkouts.checkout` is idempotent on the key),
     *  recorded on the assignment, answered with its key. */
    const ensureWorktree = Effect.fn(function* (ref: string) {
      const parsed = parseEntityRef(ref);
      if (parsed === undefined) {
        return yield* Effect.fail(
          new BadRef({ message: `${ref} is not owner/repo#N` }),
        );
      }
      const found = yield* current;
      if (!found.assigned.some((e) => e.ref === ref)) {
        return yield* Effect.fail(
          new NotAssigned({
            message: `${ref} is not assigned — assign first`,
          }),
        );
      }
      const tree = yield* sessionRepo
        .resolve(ref)
        .pipe(Effect.mapError((message) => new BadRef({ message })));
      if (tree === undefined || tree.pull === undefined) {
        return yield* Effect.fail(
          new BadRef({
            message: `${ref} is not a pull request of a connected repository`,
          }),
        );
      }
      const key = pullWorktreeKey(yield* self, parsed.number);
      const checkout = yield* checkouts
        .checkout({
          key,
          remote: tree.remote,
          ref: tree.pull.ref,
          fresh: true,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new CheckoutFailed({
                message:
                  error._tag === "Git.GitError" ? error.stderr : String(error),
              }),
          ),
        );
      yield* setWorktree(ref, checkout.path);
      return { key, path: checkout.path, branch: checkout.branch };
    });

    const worktree = yield* AI.Tool("worktree")`
      Ensure a WORKTREE for pull request ${ref} on this thread's
      machine — its head branch, fetched fresh, checked out as its own
      tree. Answers ${AI.out(path, branch)}. Engineers are placed in
      it by the spawn tool's pull argument, not by telling them the path.
      Fails with ${BadRef} for a ref that is not a pull request of a
      connected repository, ${NotAssigned} when it is not assigned
      here, ${CheckoutFailed} when git refuses.`(
      Effect.fn(function* (p: { ref: string }) {
        const made = yield* ensureWorktree(p.ref);
        return { path: made.path, branch: made.branch };
      }),
    );

    const spawn = yield* AI.Tool("spawn")`
      Kick off an ENGINEER with ${brief} — its own session on this
      thread's machine, full editor, push and pull-request tools that
      act on GitHub directly. When the work belongs to one pull
      request, name it as ${pull}: the engineer's shell, file tools,
      and terminal are then ROOTED in that pull request's worktree
      (made if need be) and it cannot reach any other tree — never
      rely on the brief to keep it there. The call returns when the
      engineer settles — answers ${AI.out(agentKey, report)}; you stay
      the point of contact, and the engineer can ${Message} you (and
      its siblings) while it works. Fails with ${BadRef} for a ${pull}
      that is not a pull request of a connected repository,
      ${NotAssigned} when it is not assigned here, ${CheckoutFailed}
      when git refuses its worktree.`(
      Effect.fn(function* (p: { brief: string; pull?: string }) {
        const id = yield* self;
        const session = { term: THREAD_TERM, key: id };
        const key = `${id}::e-${shortId()}`;
        const startedAt = Date.now();
        const pick = (yield* current).model;
        const tree =
          p.pull === undefined ? undefined : yield* ensureWorktree(p.pull);
        yield* upsertAgent({
          key,
          kind: "engineer",
          brief: p.brief,
          ...(tree === undefined ? {} : { cwd: tree.path }),
          state: "running",
          startedAt,
        });
        // an UPDATE, not an upsert: an agent the operator deleted while
        // this dispatch was in flight must not come back
        const settle = Effect.fn(function* (
          state: "done" | "failed" | "stopped",
        ) {
          const agent = yield* subagent(key);
          if (agent === undefined) return;
          yield* upsertAgent({ ...agent, state, settledAt: Date.now() });
        });
        // the engineer takes the thread's model BEFORE its brief: the
        // first contact admits the object, `setModel` writes its own
        // cell (kept in step by the thread's `setModel` from then on)
        // — so its first sampling already uses the pick
        if (pick !== undefined) {
          yield* engineer.at(key).setModel(pick);
        }
        // …and its TREE the same way: the key of this thread's worktree
        // for the pull request, so its first tool call is already
        // rooted there (sandbox/SandboxCheckout.ts) — the engineer
        // never sees the machine's root
        if (tree !== undefined) {
          yield* engineer.at(key).setTree(tree.key);
        }
        // `parent: session` from inside this round puts the engineer
        // under the thread's supervision: the operator stopping the
        // thread (abort, stop, delete) settles the engineer too. This
        // handler is then INTERRUPTED — the state says stopped, not
        // failed; a real failure of the dispatch says failed.
        const outcome = yield* engineer
          .dispatch(p.brief, { key, parent: session })
          .pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? settle(
                    Cause.hasInterruptsOnly(exit.cause) ? "stopped" : "failed",
                  )
                : Effect.void,
            ),
          );
        // the operator's off switch answers the dispatch with the
        // Stopped outcome — the state says stopped, not done
        yield* settle(
          Predicate.hasProperty(outcome, "_tag") && outcome._tag === "Stopped"
            ? "stopped"
            : "done",
        );
        return {
          agent: key,
          report: (JSON.stringify(outcome) ?? "").slice(0, 2000),
        };
      }),
    );

    const card = (input: { title: string; text: string }) =>
      Effect.flatMap(self, (id) =>
        channel.append({
          kind: "card",
          text: input.text,
          thread: id,
          card: { thread: id, title: input.title },
        }),
      );

    const postCard = yield* AI.Tool("post_card")`
      Post a CARD to the main channel — the one sanctioned way to
      reach the operator there: ${cardTitle} and ${text}. Use it when
      the thread needs them (a question only they can answer, work
      that landed and is worth a look), not as a log.`(
      Effect.fn(function* (p: { title: string; text: string }) {
        yield* card(p);
      }),
    );

    const closeThread = yield* AI.Tool("close_thread")`
      Close this thread with ${why} — the task is done or will not be
      done. Make sure the work itself already landed (pushed, pull
      requests opened); closing the thread is bookkeeping, not a
      write.`(
      Effect.fn(function* (p: { why: string }) {
        yield* card({ title: `thread closed — ${p.why}`, text: p.why });
        yield* close();
      }),
    );

    const readState = yield* AI.Tool("read_state")`
      Read this thread's fresh ${AI.out(state)} from the org's records.
      The conversation already carries all of it as it happened; call
      this for a snapshot instead of scrolling back.`(
      Effect.fn(function* () {
        const found = yield* current;
        return {
          state: {
            id: found.id,
            name: found.name,
            title: found.title,
            status: found.status,
            turn: found.turn,
            assigned: found.assigned,
            agents: found.agents.map((a) => ({
              key: a.key,
              kind: a.kind,
              brief: a.brief,
              ...(a.cwd === undefined ? {} : { cwd: a.cwd }),
              state: a.state,
            })),
          },
        };
      }),
    );

    // ── the STANCE: STATIC per thread — one prompt for the session's
    // whole life (its id is the only splice, constant for the
    // session). Never splice mutable state here: a stance that changes
    // between samplings busts the provider's prompt cache on every
    // call. The conversation history carries what happened;
    // ${readState} answers what is.

    // ── the OBJECT: the turn beside the methods. The model is the
    // one per-tick choice — the thread's pick, read from its own
    // state and provided to the byte-identical stance.
    return {
      create,
      state: getState,
      place,
      assign: assignEntities,
      unassign: unassignEntity,
      noteEvent,
      setWorktree,
      agentStop: stopAgent,
      agentResume: resumeAgent,
      agentDelete: deleteAgent,
      agents: switchAgents,
      rename,
      setModel,
      close,
      teardown,
      turn: AI.fragment`
        You are the MANAGER of ONE thread — a task over the issues and
        pull requests assigned to it (possibly across repositories).
        This session is the thread's whole conversation: the operator
        speaks to you here, GitHub events for what is assigned arrive
        here (prefixed by their payload), and your engineers report
        back here. You OWN the work end to end: your engineers push
        commits to the pull requests you govern and open new pull
        requests to solve issues — directly, no approval step. You
        never post review comments or feedback for humans to act on;
        you do the work instead.

        This thread is ${self}. The org is connected to ${repoNames};
        ${primaryName} is the primary repository, and a bare "#N" in a
        brief or a message means ${primaryName}#N — never ask which
        repository is meant. The conversation is its record — what you
        were assigned, spawned, and were told all happened here,
        including what the channel assigned on your behalf
        ("[assigned] …" messages). ${readState} answers the current
        state (what is assigned, worktrees, subagents) when you need a
        snapshot.

        Your machine is one sandbox for the whole thread. Each pull
        request you govern gets its OWN worktree (${worktree}), and an
        engineer is placed in one by ${spawn}'s pull argument — its
        shell and tools are rooted there and cannot reach another
        tree. ${spawn} runs the engineer to completion and hands you
        its report; while it works, it can ${Message} you, and you
        can ${Message} it or any engineer of this thread by name (the
        engineers are named in the "[message from …]" lines and in
        ${readState}). A message arrives in the recipient's own
        conversation. ${assign} and ${unassign} change what you govern
        — the moment an engineer reports a pull request it opened,
        ${assign} it: an unassigned pull has no review tab and its
        GitHub events route nowhere. ${postCard} is the one way to
        reach the operator in the channel — use it when work landed or
        you are blocked on them, never as a log. ${closeThread} when
        the task is done.

        Keep replies short and factual; the operator reads this
        conversation as the thread's record. Name every issue and pull
        request — in replies and in cards — as a full markdown link to
        its GitHub URL ("[owner/repo#832](https://github.com/owner/repo/pull/832)",
        /issues/ for issues), never a bare "#832": the channel renders
        those links with a hover card.`.pipe(
        Effect.provide(
          Layer.unwrap(
            Effect.map(threadState, (found) => getModel(found?.model)),
          ),
        ),
      ),
    };
  }),
);
