import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import type * as GitHub from "alchemy/GitHub";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  Channel,
  parseEntityRef,
  refOf,
  type ChannelMessage,
} from "../channel/Channel.ts";
import { Engineer } from "../coding/Engineer.ts";
import { inWorker } from "../platform/Database.ts";
import {
  pullWorktreeKey,
  THREAD_TERM,
  Threads,
  type ByOptions,
  type ThreadAgentRow,
  type Assignment,
  type ThreadSocketFrame,
  type ThreadState,
  type Turn,
} from "./Threads.ts";

/**
 * The THREAD's Durable Object — one per thread (`t-<id>`, which is
 * also the thread agent's session key and machine key). Storage is
 * the task's governance state, never a chat log: the conversation is
 * the agent session. Every mutation broadcasts the fresh snapshot to
 * `/thread/:id` watchers — the state is small, push it whole.
 */

const TAG = "thread";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS entities (
    ref TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    title TEXT NOT NULL,
    worktree TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS agents (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    brief TEXT NOT NULL,
    cwd TEXT,
    state TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    settled_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

interface EntityRow extends Record<string, Cloudflare.SqlStorageValue> {
  ref: string;
  kind: string;
  state: string;
  title: string;
  worktree: string | null;
}

interface AgentRow extends Record<string, Cloudflare.SqlStorageValue> {
  key: string;
  kind: string;
  brief: string;
  cwd: string | null;
  state: string;
  started_at: number;
  settled_at: number | null;
}

interface ThreadRpc extends MainRpc<Cloudflare.DurableObjectState> {
  readonly init: (input: {
    readonly id: string;
    readonly name: string;
    readonly title: string;
  }) => Effect.Effect<ThreadState, never, RuntimeContext>;
  readonly state: () => Effect.Effect<
    ThreadState | undefined,
    never,
    RuntimeContext
  >;
  readonly place: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ThreadState, never, RuntimeContext>;
  readonly assign: (
    assigned: ReadonlyArray<{
      readonly ref: string;
      readonly kind: "issue" | "pull";
      readonly title: string;
      readonly state?: string;
    }>,
  ) => Effect.Effect<ThreadState, never, RuntimeContext>;
  readonly unassign: (
    ref: string,
  ) => Effect.Effect<ThreadState, never, RuntimeContext>;
  readonly noteEvent: (
    event: GitHub.RepositoryEvent,
  ) => Effect.Effect<ThreadState, never, RuntimeContext>;
  readonly setWorktree: (
    ref: string,
    worktree: string,
  ) => Effect.Effect<ThreadState, never, RuntimeContext>;
  readonly agentUpsert: (
    row: ThreadAgentRow,
  ) => Effect.Effect<ThreadState, never, RuntimeContext>;
  /** Settle an agent's row — an UPDATE, never an insert: a row the
   *  operator deleted while the dispatch was in flight stays gone. */
  readonly agentSettle: (
    key: string,
    state: ThreadAgentRow["state"],
    settledAt: number,
  ) => Effect.Effect<ThreadState, never, RuntimeContext>;
  /** Forget an agent — its row goes; the session is the caller's. */
  readonly agentRemove: (
    key: string,
  ) => Effect.Effect<ThreadState, never, RuntimeContext>;
  readonly rename: (input: {
    readonly name?: string;
    readonly title?: string;
  }) => Effect.Effect<ThreadState, never, RuntimeContext>;
  readonly close: () => Effect.Effect<ThreadState, never, RuntimeContext>;
  /** Erase this thread: the last snapshot (for the caller to unwind
   *  the channel projections), then every row is gone and watchers
   *  are closed. `undefined` when the thread never existed. */
  readonly destroy: () => Effect.Effect<
    ThreadState | undefined,
    never,
    RuntimeContext
  >;
}

const ThreadDOLive = Cloudflare.DurableObject<ThreadRpc>()(
  "ThreadDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;

    const createTables = Effect.forEach(
      TABLES,
      (table) =>
        sql.exec(table.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid),
      { discard: true },
    );
    const ensured = yield* Effect.cached(createTables);

    const metaGet = (key: string) =>
      Effect.gen(function* () {
        const cursor = yield* sql.exec<
          { value: string } & Record<string, Cloudflare.SqlStorageValue>
        >("SELECT value FROM meta WHERE key = ?", key);
        return (yield* cursor.toArray())[0]?.value;
      });

    const metaSet = (key: string, value: string) =>
      sql
        .exec(
          "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
          key,
          value,
        )
        .pipe(Effect.asVoid);

    const snapshot: Effect.Effect<
      ThreadState | undefined,
      never,
      RuntimeContext
    > = Effect.gen(function* () {
      yield* ensured;
      const id = yield* metaGet("id");
      if (id === undefined) return undefined;
      const assigned = (yield* (yield* sql.exec<EntityRow>(
        "SELECT * FROM entities ORDER BY ref ASC",
      )).toArray()).map((row): Assignment => ({
        ref: row.ref,
        kind: row.kind as Assignment["kind"],
        state: row.state,
        title: row.title,
        ...(row.worktree === null ? {} : { worktree: row.worktree }),
      }));
      const agents = (yield* (yield* sql.exec<AgentRow>(
        "SELECT * FROM agents ORDER BY started_at ASC",
      )).toArray()).map((row): ThreadAgentRow => ({
        key: row.key,
        kind: row.kind as ThreadAgentRow["kind"],
        brief: row.brief,
        ...(row.cwd === null ? {} : { cwd: row.cwd }),
        state: row.state as ThreadAgentRow["state"],
        startedAt: row.started_at,
        ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
      }));
      const members = (yield* (yield* sql.exec<
        { id: string } & Record<string, Cloudflare.SqlStorageValue>
      >("SELECT id FROM members ORDER BY at ASC")).toArray()).map(
        (row) => row.id,
      );
      const status = ((yield* metaGet("status")) ?? "open") as
        | "open"
        | "closed";
      const turn: Turn =
        status === "closed"
          ? "idle"
          : agents.some((a) => a.state === "running")
            ? "agents"
            : assigned.some((e) => e.state === "open")
              ? "others"
              : "idle";
      return {
        id,
        name: (yield* metaGet("name")) ?? id,
        title: (yield* metaGet("title")) ?? id,
        status,
        turn,
        createdAt: Number((yield* metaGet("created_at")) ?? 0),
        updatedAt: Number((yield* metaGet("updated_at")) ?? 0),
        assigned,
        agents,
        members,
      } satisfies ThreadState;
    });

    const broadcast = (snap: ThreadState) =>
      Effect.gen(function* () {
        const sockets = yield* state.getWebSockets(TAG);
        const data = JSON.stringify({
          type: "state",
          state: snap,
        } satisfies ThreadSocketFrame);
        yield* Effect.forEach(
          sockets,
          (socket) => Effect.ignore(socket.send(data)),
          { discard: true },
        );
      });

    /** Every mutation ends here: bump, snapshot, push, return. */
    const commit = Effect.gen(function* () {
      yield* metaSet("updated_at", String(yield* Clock.currentTimeMillis));
      const snap = yield* snapshot;
      if (snap === undefined) {
        return yield* Effect.die("thread commit before init");
      }
      yield* broadcast(snap);
      return snap;
    });

    return Effect.succeed<ThreadRpc>({
      fetch: Effect.gen(function* () {
        yield* HttpServerRequest;
        const [response, socket] = yield* Cloudflare.upgrade({ tags: [TAG] });
        const snap = yield* snapshot;
        if (snap !== undefined) {
          yield* Effect.ignore(
            socket.send(
              JSON.stringify({
                type: "state",
                state: snap,
              } satisfies ThreadSocketFrame),
            ),
          );
        }
        return response;
      }) as Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        RuntimeContext | Cloudflare.DurableObjectState
      >,

      webSocketClose: (
        socket: Cloudflare.WebSocket,
        code: number,
        reason: string,
      ) =>
        Effect.gen(function* () {
          const echo = code === 1005 || code === 1006 || code === 1015;
          yield* Effect.ignore(
            socket.close(echo ? 1000 : code, echo ? "" : reason),
          );
        }),

      init: (input) =>
        Effect.gen(function* () {
          yield* ensured;
          const existing = yield* metaGet("id");
          if (existing === undefined) {
            const now = yield* Clock.currentTimeMillis;
            yield* metaSet("id", input.id);
            yield* metaSet("name", input.name);
            yield* metaSet("title", input.title);
            yield* metaSet("status", "open");
            yield* metaSet("created_at", String(now));
          }
          return yield* commit;
        }),

      state: () =>
        Effect.gen(function* () {
          return yield* snapshot;
        }),

      place: (ids) =>
        Effect.gen(function* () {
          yield* ensured;
          const at = yield* Clock.currentTimeMillis;
          yield* Effect.forEach(
            ids,
            (id) =>
              sql
                .exec(
                  "INSERT OR IGNORE INTO members (id, at) VALUES (?, ?)",
                  id,
                  at,
                )
                .pipe(Effect.asVoid),
            { discard: true },
          );
          return yield* commit;
        }),

      assign: (items) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* Effect.forEach(
            items,
            (entity) =>
              sql
                .exec(
                  `INSERT INTO entities (ref, kind, state, title) VALUES (?, ?, ?, ?)
                   ON CONFLICT(ref) DO UPDATE SET kind = excluded.kind, state = excluded.state, title = excluded.title`
                    .trim()
                    .replaceAll(/\s+/g, " "),
                  entity.ref,
                  entity.kind,
                  entity.state ?? "open",
                  entity.title,
                )
                .pipe(Effect.asVoid),
            { discard: true },
          );
          return yield* commit;
        }),

      unassign: (ref) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* sql.exec("DELETE FROM entities WHERE ref = ?", ref);
          return yield* commit;
        }),

      noteEvent: (event) =>
        Effect.gen(function* () {
          yield* ensured;
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
              : event._tag === "PullRequestClosed" ||
                  event._tag === "IssueClosed"
                ? "closed"
                : event._tag === "PullRequestOpened" ||
                    event._tag === "IssueOpened"
                  ? "open"
                  : undefined;
          if (ref !== undefined && next !== undefined) {
            yield* sql.exec(
              "UPDATE entities SET state = ? WHERE ref = ?",
              next,
              ref,
            );
          }
          return yield* commit;
        }),

      setWorktree: (ref, worktree) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* sql.exec(
            "UPDATE entities SET worktree = ? WHERE ref = ?",
            worktree,
            ref,
          );
          return yield* commit;
        }),

      agentUpsert: (row) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* sql.exec(
            "INSERT OR REPLACE INTO agents (key, kind, brief, cwd, state, started_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            row.key,
            row.kind,
            row.brief,
            row.cwd ?? null,
            row.state,
            row.startedAt,
            row.settledAt ?? null,
          );
          return yield* commit;
        }),

      agentSettle: (key, state, settledAt) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* sql.exec(
            "UPDATE agents SET state = ?, settled_at = ? WHERE key = ?",
            state,
            settledAt,
            key,
          );
          return yield* commit;
        }),

      agentRemove: (key) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* sql.exec("DELETE FROM agents WHERE key = ?", key);
          return yield* commit;
        }),

      rename: (input) =>
        Effect.gen(function* () {
          yield* ensured;
          if (input.name !== undefined) yield* metaSet("name", input.name);
          if (input.title !== undefined) yield* metaSet("title", input.title);
          return yield* commit;
        }),

      close: () =>
        Effect.gen(function* () {
          yield* ensured;
          yield* metaSet("status", "closed");
          return yield* commit;
        }),

      destroy: () =>
        Effect.gen(function* () {
          const snap = yield* snapshot;
          // watchers see the end, not a stale snapshot
          for (const socket of yield* state.getWebSockets(TAG)) {
            yield* Effect.ignore(socket.close(1000, "thread deleted"));
          }
          yield* state.storage.deleteAll().pipe(Effect.orDie);
          // this instance stays resident with `ensured` already run —
          // recreate the (empty) tables now so a later `state()` on
          // the same name reads "never existed" instead of failing
          yield* createTables;
          return snap;
        }),
    });
  }),
);

/** A thread's row in the channel's directory. */
const directoryOf = (snap: ThreadState) => ({
  id: snap.id,
  name: snap.name,
  title: snap.title,
  status: snap.status,
  turn: snap.turn,
  updatedAt: snap.updatedAt,
});

/**
 * A PHANTOM thread identity — just enough `AI.Thread` for the sandbox
 * layer to derive a thread's machine (it only reads `key`). Lets the
 * facade drop a thread's worktrees without being inside its session.
 */
const phantomThread = (key: string): AI.ThreadService => ({
  key,
  tokens: Effect.succeed(0),
  entries: Effect.succeed([]),
  compact: () => Effect.void,
  reply: () => Effect.void,
  remind: () => Effect.void,
});

/** The engineers' session term — the thread's agent rows are its keys. */
const engineerTerm = Engineer["~alchemy/Name"];

/** A placed channel message, as the thread's agent hears it. */
const quote = (message: ChannelMessage): string =>
  `[channel] ${message.author?.login ?? message.kind} · ${new Date(
    message.at,
  ).toISOString()}\n${message.text}`;

/**
 * The {@link Threads} facade — the thread as an object. Books through
 * the per-thread DO stub, the agent through `AI.Sessions` by name
 * (`Thread/<id>` — the agent's Layer depends on this one, so the
 * agent's tag is never resolved here), projections into the channel
 * on every mutation. Cross-DO writes are idempotent on their ids; the
 * ThreadDO's storage is truth if a projection disagrees.
 */
export const ThreadsLive: Layer.Layer<
  Threads,
  never,
  Cloudflare.Worker | Channel | AI.Sessions
> = Layer.effect(
  Threads,
  Effect.gen(function* () {
    const namespace = yield* ThreadDOLive;
    const channel = yield* Channel;
    const sessions = yield* AI.Sessions;
    // OPTIONAL: dropping a deleted thread's worktrees runs git over
    // the thread's machine; without the seam the trees are left
    const checkouts = yield* Effect.serviceOption(Git.Checkouts);
    const stub = (id: string) => namespace.getByName(id);

    const project = (snap: ThreadState) =>
      channel.directoryUpsert(directoryOf(snap)).pipe(Effect.as(snap));

    // ── the agent, by name ──────────────────────────────────────────
    // a delivery that fails must never cost the caller its books
    // write (already committed) — logged, contained
    const tell = (id: string, input: unknown, wake: boolean) =>
      inWorker(sessions.send(THREAD_TERM, id, input, { wake })).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`thread ${id}: telling the agent failed`, cause),
        ),
      );
    const told = (options: ByOptions | undefined) => options?.by !== "agent";

    const agentRow = (id: string, key: string) =>
      Effect.map(inWorker(stub(id).state()), (snap) =>
        snap?.agents.find((agent) => agent.key === key),
      );

    const self: Threads["Service"] = Threads.of({
      create: (input) =>
        Effect.gen(function* () {
          const id = input.id ?? crypto.randomUUID();
          const snap = yield* inWorker(
            stub(id).init({ id, name: input.name, title: input.title }),
          );
          return yield* project(snap);
        }),
      get: (id) => inWorker(stub(id).state()),
      brief: (id, text) => inWorker(sessions.send(THREAD_TERM, id, text)),
      tell: (id, input) => tell(id, input, false),
      place: (id, messageIds, options) =>
        Effect.gen(function* () {
          const snap = yield* inWorker(stub(id).place(messageIds));
          yield* channel.tag(messageIds, id, true);
          if (told(options) && messageIds.length > 0) {
            // the rows themselves, oldest first — the operator's words
            // reach the agent as said, not as the channel summarized them
            const rows = yield* channel.read(messageIds);
            yield* Effect.forEach(
              [...rows].sort((a, b) => a.seq - b.seq),
              (row) => tell(id, quote(row), false),
              { discard: true },
            );
          }
          return yield* project(snap);
        }),
      assign: (id, items, options) =>
        Effect.gen(function* () {
          const snap = yield* inWorker(stub(id).assign(items));
          yield* Effect.forEach(
            items,
            (entity) => channel.attachmentsSet(entity.ref, id),
            { discard: true },
          );
          if (told(options)) {
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
                  false,
                ),
              { discard: true },
            );
          }
          return yield* project(snap);
        }),
      unassign: (id, ref, options) =>
        Effect.gen(function* () {
          const snap = yield* inWorker(stub(id).unassign(ref));
          yield* channel.attachmentsSet(ref, null);
          if (told(options)) yield* tell(id, `[unassigned] ${ref}`, false);
          return yield* project(snap);
        }),
      noteEvent: (id, event) =>
        Effect.gen(function* () {
          const snap = yield* inWorker(stub(id).noteEvent(event));
          // the agent hears the event as non-waking input — context,
          // not a trigger; it reads it at its next wake
          yield* tell(id, event, false);
          return yield* project(snap);
        }),
      setWorktree: (id, ref, worktree) =>
        Effect.gen(function* () {
          const snap = yield* inWorker(stub(id).setWorktree(ref, worktree));
          return yield* project(snap);
        }),
      agentUpsert: (id, row) =>
        Effect.gen(function* () {
          const snap = yield* inWorker(stub(id).agentUpsert(row));
          return yield* project(snap);
        }),
      agentSettle: (id, key, state, settledAt) =>
        Effect.gen(function* () {
          const snap = yield* inWorker(
            stub(id).agentSettle(key, state, settledAt),
          );
          return yield* project(snap);
        }),
      agentStop: (id, key) =>
        Effect.gen(function* () {
          const row = yield* agentRow(id, key);
          if (row === undefined) return undefined;
          yield* inWorker(sessions.stop(engineerTerm, key));
          const snap = yield* inWorker(
            stub(id).agentUpsert({
              ...row,
              state: "stopped",
              settledAt: Date.now(),
            }),
          );
          return yield* project(snap);
        }),
      agentResume: (id, key) =>
        Effect.gen(function* () {
          const row = yield* agentRow(id, key);
          if (row === undefined) return undefined;
          yield* inWorker(sessions.resume(engineerTerm, key));
          const { settledAt: _settled, ...rest } = row;
          const snap = yield* inWorker(
            stub(id).agentUpsert({ ...rest, state: "running" }),
          );
          return yield* project(snap);
        }),
      agentDelete: (id, key) =>
        Effect.gen(function* () {
          const row = yield* agentRow(id, key);
          if (row === undefined) return undefined;
          yield* inWorker(
            sessions.remove(engineerTerm, key, { machine: false }),
          );
          const snap = yield* inWorker(stub(id).agentRemove(key));
          return yield* project(snap);
        }),
      agents: (id, verb, keys) =>
        Effect.gen(function* () {
          const before = yield* inWorker(stub(id).state());
          if (before === undefined) return undefined;
          const chosen =
            keys === undefined
              ? before.agents
              : before.agents.filter((agent) => keys.includes(agent.key));
          // the single verbs, each contained: one agent's session
          // refusing must not leave the others running
          const one = (key: string) =>
            (verb === "stop"
              ? self.agentStop(id, key)
              : verb === "resume"
                ? self.agentResume(id, key)
                : self.agentDelete(id, key)
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
          const snap = yield* inWorker(stub(id).state());
          return snap === undefined ? undefined : yield* project(snap);
        }),
      postCard: (id, card) =>
        Effect.gen(function* () {
          yield* channel.append({
            kind: "card",
            text: card.text,
            thread: id,
            card: {
              thread: id,
              title: card.title,
              ...(card.review === undefined ? {} : { review: card.review }),
            },
          });
        }),
      rename: (id, input) =>
        Effect.gen(function* () {
          const snap = yield* inWorker(stub(id).rename(input));
          return yield* project(snap);
        }),
      close: (id) =>
        Effect.gen(function* () {
          const snap = yield* inWorker(stub(id).close());
          return yield* project(snap);
        }),
      remove: (id) =>
        Effect.gen(function* () {
          const before = yield* inWorker(stub(id).state());
          // 1. the thread's own agent: settled, round cut, machine down
          yield* inWorker(sessions.remove(THREAD_TERM, id));
          // 2. every session descended from it — the agent rows, then
          // the index's parent edges walked transitively from the
          // thread's session (a directory: a stale or absent index only
          // means fewer rows here, never a wrong one). Anonymous
          // `spawn-*` workers are skipped: they ran inside their
          // spawner's round and died with it in step 1.
          const descendants = new Map<string, { term: string; key: string }>();
          for (const agent of before?.agents ?? []) {
            descendants.set(AI.sessionId(engineerTerm, agent.key), {
              term: engineerTerm,
              key: agent.key,
            });
          }
          const listed = yield* inWorker(sessions.list());
          const frontier = [
            AI.sessionId(THREAD_TERM, id),
            ...descendants.keys(),
          ];
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
          yield* Effect.forEach(
            descendants.values(),
            ({ term, key }) =>
              inWorker(sessions.remove(term, key, { machine: false })),
            { discard: true, concurrency: 8 },
          );
          // 3. the pull requests' worktrees on the thread's machine
          if (Option.isSome(checkouts)) {
            yield* Effect.forEach(
              (before?.assigned ?? []).flatMap((entity) => {
                const parsed = parseEntityRef(entity.ref);
                return entity.worktree === undefined ||
                  entity.worktree === "." ||
                  entity.worktree === "" ||
                  parsed === undefined
                  ? []
                  : [pullWorktreeKey(id, parsed.number)];
              }),
              (key) =>
                checkouts.value.release(key).pipe(
                  Effect.provideService(AI.Thread, phantomThread(id)),
                  Effect.catch((error) =>
                    Effect.logWarning(
                      `deleting thread '${id}': dropping worktree '${key}' failed (contained): ${error.message}`,
                    ),
                  ),
                ),
              { discard: true },
            );
          }
          // 4. the record, last
          const snap = yield* inWorker(stub(id).destroy());
          // the DO is gone either way; the projections unwind from
          // the last snapshot (directoryRemove also frees every
          // attachment the thread held, snapshot or not)
          if (snap !== undefined && snap.members.length > 0) {
            yield* channel.tag(snap.members, null, false);
          }
          yield* channel.directoryRemove(id);
          return snap;
        }),
      socket: (id, request) =>
        inWorker(stub(id).fetch(request).pipe(Effect.orDie)),
    });
    return self;
  }),
);
