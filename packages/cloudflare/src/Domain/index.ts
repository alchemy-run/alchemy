import type * as Aggregate from "@alchemy.run/domain/Aggregate";
import { AlreadyCancelled, AlreadyExecuted, NotScheduled } from "@alchemy.run/domain/Aggregate";
import { earliest, laggingFrom, routeLive, type Routed } from "@alchemy.run/domain/CatchUp";
import { isAfter, mergeCheckpoints } from "@alchemy.run/domain/InMemory";
import { captureContext } from "@alchemy.run/domain/internal";
import {
  type Accepted,
  type AggregateKit,
  type Delivery,
  emptySnapshot,
  emptyStreamMeta,
  Platform,
  type Json,
  type PolicyKit,
  type ProjectionKit,
  type Push,
  type SendResult,
  type StoredEvent,
  type StreamEntry,
  type StreamKit,
  type StreamMeta,
  type StreamWrite,
  Subscription,
  type ViewEntry,
  type ViewKit,
  type ViewSnapshot,
} from "@alchemy.run/domain/Platform";
import { makeCallback } from "alchemy/Callback";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { WorkflowEngine } from "effect/workflow";
import { DurableObject as CloudflareDurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { upgrade, type WebSocket } from "../Workers/WebSocket.ts";
import type { Worker } from "../Workers/Worker.ts";
import { DurableObjectEngine } from "../Workflows/DurableObjectEngine.ts";

const pad = (n: number) => n.toString().padStart(12, "0");

const DefectTag = "alchemy/Domain/Defect";

/**
 * Workers RPC replaces thrown errors with an opaque "internal error". Return
 * failures as data instead, and rethrow them as defects on the calling side.
 */
const reportDefects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ [DefectTag]: Cause.pretty(cause) } as unknown as A),
    ),
  );

/**
 * How long to keep retrying a Durable Object call that failed in transit:
 * an instance being reset reports an opaque "internal error", and for a while
 * after a deploy some instances still run the previous script (whose classes
 * "do not implement" our methods). Backs off from 100ms to 2s, about a minute
 * in total, so a call survives a deploy's rollout.
 */
const TRANSIT_RETRY = {
  // Whichever delay is shorter: exponential at first, then every 2 seconds.
  schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
  times: 35,
} as const;

/**
 * Call a Durable Object. A call that fails in transit is retried: every Domain
 * object method is idempotent (sends dedupe by command id, deliveries by
 * checkpoint, schedules replace, reads are reads). A defect the object
 * reported, or a call that keeps failing, is a defect for the caller.
 */
const unwrapDefects = <A>(call: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
  call.pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry(TRANSIT_RETRY),
    Effect.catch((error) => Effect.die(error)),
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && DefectTag in value
        ? Effect.die(new Error(String((value as Record<string, unknown>)[DefectTag])))
        : Effect.succeed(value as A),
    ),
  );

/** A Durable Object stub: every method is an RPC returning an Effect. */
interface Stub {
  readonly [method: string]: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
}

interface Namespace {
  readonly getByName: (name: string) => Stub & {
    readonly fetch: (
      request: HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
  };
}

/** What an instance's methods and constructor run with. */
type InstanceServices = DurableObjectState | RuntimeContext | Scope.Scope;

/** The usual outer (construction) / inner (instance) pair. */
type ObjectImpl = Effect.Effect<
  Effect.Effect<Record<string, unknown>, never, InstanceServices>,
  never,
  DurableObjectState
>;

/**
 * Declare a Durable Object class on the host Worker from inside a factory.
 * The inline form of `Cloudflare.DurableObject` is typed for single-stage
 * implementations, so it is re-typed here for the two-stage form it runs.
 */
const declare = CloudflareDurableObject as unknown as (
  name: string,
  impl: ObjectImpl,
) => Effect.Effect<Namespace, never, Worker>;

/**
 * Run `effect` with every other event on this instance held back. Durable
 * Objects run each event in its own I/O context, so cross-event in-memory
 * coordination (semaphores, refs, deferreds) is unsafe; the platform's gate
 * is not.
 */
const exclusively = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const exit = yield* state.blockConcurrencyWhile(() => Effect.exit(effect));
    return yield* exit;
  });

/** What `scheduled:<commandId>` holds once that command is cancelled; never a job token. */
const CANCELLED = "cancelled";

/** How long a queue drain may hold its lease before another drain may take over. */
const LEASE_MS = 60_000;

/**
 * A durable, ordered work queue in the instance's storage. Rows are written
 * in the same transaction as the state change that produced them, processed
 * right after the commit (`kick`), and again by a durable callback if the
 * instance dies first. One drain runs at a time (a storage lease), rows are
 * processed in order, and a row is deleted only after its work succeeds.
 */
const queue = <Row>(name: string, process: (row: Row) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const prefix = `${name}:`;
    const lease = `${name}-lease`;
    const acquire = exclusively(
      Effect.gen(function* () {
        const held = yield* state.storage.get<number>(lease);
        if (held !== undefined && held > Date.now()) return false;
        yield* state.storage.put(lease, Date.now() + LEASE_MS);
        return true;
      }),
    );
    const drain: Effect.Effect<void> = Effect.gen(function* () {
      if (!(yield* acquire)) return;
      yield* Effect.gen(function* () {
        const rows = yield* state.storage.list<Row>({ prefix });
        for (const [key, row] of rows) {
          yield* process(row);
          yield* state.storage.delete(key);
        }
      }).pipe(Effect.ensuring(state.storage.delete(lease).pipe(Effect.ignore)));
      // Rows staged while this drain ran.
      const more = yield* state.storage.list({ prefix, limit: 1 });
      if (more.size > 0) yield* drain;
    }) as Effect.Effect<void>;
    const callback = yield* makeCallback(`domain:${name}`, () => drain);
    return {
      /** Stage rows; call inside the storage transaction that commits their cause. */
      stage: (rows: ReadonlyArray<Row>) =>
        Effect.gen(function* () {
          if (rows.length === 0) return;
          const last = ((yield* state.storage.get<number>(`${name}-seq`)) ?? 0) + rows.length;
          const entries: Record<string, Row> = {};
          rows.forEach((row, index) => {
            entries[`${prefix}${pad(last - rows.length + index + 1)}`] = row;
          });
          yield* state.storage.put(entries);
          yield* state.storage.put(`${name}-seq`, last);
          // The backstop: delivered even if this instance dies before `kick` runs.
          yield* callback.schedule("drain", { after: "10 seconds", payload: {} });
        }),
      /** Process staged rows now, in the background, keeping the instance alive until done. */
      kick: state.waitUntil(drain.pipe(Effect.ignoreCause)),
      /** Process staged rows now, and wait (unless another drain holds the lease). */
      flush: drain,
    };
  });

// ---------------------------------------------------------------- live reads

/** What a live read's WebSocket carries across hibernation. */
const Attachment = Schema.Struct({ key: Schema.String, subscription: Subscription });
type Attachment = typeof Attachment.Type;
const decodeAttachment = Schema.decodeUnknownOption(Schema.fromJsonString(Attachment));

const SUBSCRIPTION_HEADER = "x-domain-subscription";

/** Send a push to its socket; close it when the read ended or could not be judged. */
const deliverPush = <R>(socket: WebSocket, key: string, push: Effect.Effect<Push, never, R>) =>
  push.pipe(
    Effect.flatMap((pushed) =>
      Effect.gen(function* () {
        // Each frame carries the cursor a reconnecting client resumes from.
        const cursor = pushed.subscription.cursor;
        for (const message of pushed.messages) {
          yield* socket.send(JSON.stringify({ ...(message as object), cursor }));
        }
        if (pushed.done) return yield* socket.close(1000, "");
        yield* Effect.sync(() =>
          socket.serializeAttachment({
            key,
            subscription: pushed.subscription,
          } satisfies Attachment),
        );
      }),
    ),
    Effect.catchCause(() => socket.close(1011, "Domain could not push to this read")),
  );

/**
 * Accept a live read's WebSocket (the current request, forwarded by
 * {@link connectTo}) with the hibernation API, and send what it starts with.
 * Runs exclusively, so no commit's push interleaves with the first one.
 */
const accept = (
  initial: (
    key: string,
    subscription: Subscription,
  ) => Effect.Effect<Push, never, DurableObjectState | RuntimeContext>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const header = request.headers[SUBSCRIPTION_HEADER];
    if (header === undefined || request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.empty({ status: 426, headers: { Upgrade: "websocket" } });
    }
    const attachment = decodeAttachment(header);
    if (Option.isNone(attachment)) {
      return HttpServerResponse.text("Invalid live read", { status: 400 });
    }
    const { key, subscription } = attachment.value;
    return yield* exclusively(
      Effect.gen(function* () {
        const [response, socket] = yield* upgrade();
        if (subscription.refused !== undefined) {
          yield* socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: subscription.requestId,
              exit: subscription.refused,
            }),
          );
          yield* socket.close(1000, "");
          return response;
        }
        yield* deliverPush(socket, key, initial(key, subscription));
        return response;
      }),
    );
  });

/** Push to every live read of this instance after a commit. Runs inside the commit's exclusive section. */
const broadcast = (
  push: (attachment: Attachment) => Effect.Effect<Push, never, DurableObjectState | RuntimeContext>,
) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    for (const socket of yield* state.getWebSockets()) {
      const attachment = socket.deserializeAttachment<Attachment>();
      if (attachment === null) continue;
      yield* deliverPush(socket, attachment.key, push(attachment));
    }
  });

/** Live reads only receive; a client message or close needs no work beyond ending the socket. */
const socketHandlers = {
  webSocketMessage: () => Effect.void,
  webSocketClose: (socket: WebSocket) => socket.close(1000, "").pipe(Effect.ignoreCause),
  webSocketError: (socket: WebSocket) => socket.close(1011, "").pipe(Effect.ignoreCause),
};

/**
 * Forward a WebSocket upgrade (the current request) to the instance that owns
 * `key`, carrying the subscription. The Worker sets the header, overwriting
 * any a client sent, so the object can trust it.
 */
const connectTo = (namespace: Namespace) => (key: string, subscription: Subscription) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const forwarded = request.modify({
      headers: Headers.set(
        request.headers,
        SUBSCRIPTION_HEADER,
        JSON.stringify({ key, subscription } satisfies Attachment),
      ),
    });
    // Like every other call, ride out a deploy's rollout: an instance still
    // running the previous script cannot upgrade, so retry until one does.
    const response = yield* namespace
      .getByName(key)
      .fetch(forwarded)
      .pipe(
        Effect.filterOrFail(
          (response) => response.status === 101,
          (response) => new Error(`Live read upgrade answered ${response.status}`),
        ),
        Effect.retry(TRANSIT_RETRY),
        Effect.orDie,
      );
    // A fetched Response's headers are immutable; re-wrap the socket so
    // middleware (CORS, cookies) can still add headers to the upgrade.
    const body = response.body;
    if (body._tag === "Raw" && body.body instanceof Response) {
      const webSocket = (body.body as unknown as { readonly webSocket: unknown }).webSocket;
      if (webSocket) {
        return HttpServerResponse.raw(
          new Response(null, { status: 101, webSocket } as ResponseInit),
          { status: 101 },
        );
      }
    }
    return response;
  });

// ---------------------------------------------------------------- catch-up

/** Delete every stored key under these prefixes, a batch at a time. */
const clearPrefixes = (prefixes: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    for (const prefix of prefixes) {
      while (true) {
        const keys = [...(yield* state.storage.list({ prefix, limit: 128 })).keys()];
        if (keys.length === 0) break;
        yield* state.storage.delete(keys);
      }
    }
  });

/** Events (or view entries) an instance replays per transaction while catching up. */
const CATCH_UP_PAGE = 100;

/** Rows an instance replays per `catchUp` call; the directory calls it again for the rest. */
const CATCH_UP_BUDGET = 500;

/**
 * How much history each catch-up round replays: a consumer added later sees
 * many instances' events roughly in the order they happened, a window at a time.
 */
const CATCH_UP_WINDOW_MS = 60 * 60 * 1000;

/** What a `catchUp` call left: the earliest event past the round, and whether it ran out of budget. */
interface CatchUpResult {
  readonly next: number | undefined;
  readonly pending: boolean;
}

/**
 * Replay an instance's history to its lagging consumers up to a round's
 * `until`, a page per transaction, delivering each page before the next.
 * `page` reads the rows after the lowest lagging cursor and replays them, or
 * answers `undefined` when nothing lags.
 */
const catchUp = <E1, R1, E2, R2, E3, R3>(
  outbox: {
    readonly stage: (rows: ReadonlyArray<Delivery>) => Effect.Effect<void, E1, R1>;
    readonly flush: Effect.Effect<void, E2, R2>;
  },
  model: ReadonlySet<string>,
  targets: ReadonlyArray<string>,
  page: (routed: Routed | undefined) => Effect.Effect<
    | {
        readonly version: number;
        readonly rows: number;
        readonly result: {
          readonly deliveries: ReadonlyArray<Delivery>;
          readonly routed: Routed;
          readonly next: number | undefined;
        };
      }
    | undefined,
    E3,
    R3
  >,
) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    // A consumer this code doesn't know: it still runs the code from before the deploy that
    // started the sweep, and keeps it until it has been idle. Ask to be called again.
    if (!targets.every((target) => model.has(target)))
      return { next: undefined, pending: true } satisfies CatchUpResult;
    let replayed = 0;
    while (true) {
      const step = yield* exclusively(
        Effect.gen(function* () {
          const replay = yield* page(yield* state.storage.get<Routed>("routed"));
          if (replay === undefined) return { done: true, next: undefined, rows: 0 };
          yield* state.storage.transaction(
            Effect.gen(function* () {
              yield* state.storage.put("routed", replay.result.routed);
              yield* outbox.stage(replay.result.deliveries);
            }),
          );
          return {
            // Stopped at the round's end, or replayed every row it had.
            done: replay.result.next !== undefined || replay.rows < CATCH_UP_PAGE,
            next: replay.result.next,
            rows: replay.rows,
          };
        }),
      );
      // Deliver before answering, so a round's events land before the next round's. A
      // consumer still on older code refuses them: they stay staged, and the outbox's
      // backstop delivers them once it runs the deployed code.
      yield* Effect.ignoreCause(outbox.flush);
      replayed += step.rows;
      if (step.done) return { next: step.next, pending: false } satisfies CatchUpResult;
      if (replayed >= CATCH_UP_BUDGET)
        return { next: undefined, pending: true } satisfies CatchUpResult;
    }
  });

// ---------------------------------------------------------------- directory

/**
 * Durable Objects cannot be listed, so every source instance (an aggregate
 * instance, or a view key) lists itself in a directory when it first commits.
 * The directory is a tree of objects with a fan-out of 16: an instance's leaf
 * is the first {@link DIRECTORY_DEPTH} hex digits of a hash of its source and
 * id, so it is found without a lookup, and a node is created by the first
 * write to it, then links itself into its parent.
 *
 * Catching up a consumer added later runs over the tree in rounds. Each
 * isolate tells one random node of the model's consumers (`news`); a node
 * passes news up only the first time it hears it, so each node gets at most
 * one message per child, and the root starts a sweep. A round goes down the
 * tree (each node tells its children and catches up its own instances up to
 * the round's `until`), and reports come back up with the earliest event left.
 * The root then starts the next round a window past it, until none is left.
 *
 * Every step runs in its own alarm (a durable callback), so no call chain is
 * deeper than one hop and a crash resumes from stored progress. Every message
 * is idempotent: rounds and reports carry their sweep generation and round.
 */
const DIRECTORY_DEPTH = 4;

/** Instances a directory node catches up per alarm, and calls it makes at once. */
const DIRECTORY_PAGE = 25;
const DIRECTORY_CONCURRENCY = 5;

/** An instance listed in the directory. */
interface Registration {
  readonly source: string;
  readonly id: string;
}

/** What an instance needs of the directory. */
interface Directory {
  readonly register: (row: Registration) => Effect.Effect<void>;
}

/** The leaf an instance is listed in: a prefix of the FNV-1a hash of its source and id. */
const leafOf = ({ source, id }: Registration) => {
  let hash = 0x811c9dc5;
  for (const char of `${source}/${id}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, DIRECTORY_DEPTH);
};

const parentOf = (path: string) => path.slice(0, -1);

/** A directory node's progress through the current round of a sweep. */
interface Sweep {
  /** Bumped by the root whenever news brings a new consumer: older messages are ignored. */
  readonly gen: number;
  readonly round: number;
  /** Replay events committed before this time, in epoch milliseconds. */
  readonly until: number;
  /** The model's consumers when the sweep started: an instance on older code asks to be called again. */
  readonly targets: ReadonlyArray<string>;
  /** The children told of this round, and their reports: the earliest event each has left. */
  readonly children: ReadonlyArray<string>;
  readonly told: boolean;
  readonly reports: Readonly<Record<string, number | null>>;
  /** This node's own instances: the last one listed, those to call again, the earliest event left. */
  readonly cursor: string | null;
  readonly listed: boolean;
  readonly pending: ReadonlyArray<Registration>;
  readonly earliest: number | null;
  /** Every own instance has caught up to `until`. */
  readonly own: boolean;
  /** The round is reported to the parent (or, at the root, finished). */
  readonly reported: boolean;
}

interface DirectoryJob {
  readonly kind: "link" | "news" | "round" | "report";
  readonly path: string;
  /** For `report`: the round reported, as it was when it finished here. */
  readonly report?: {
    readonly gen: number;
    readonly round: number;
    readonly earliest: number | null;
  };
}

/** A directory node, called by its path. */
interface DirectoryNode {
  /** At the root: the consumers whose history has fully arrived, and how far the running sweep is. */
  readonly status: () => Effect.Effect<{
    readonly complete: ReadonlyArray<string>;
    readonly through: { readonly targets: ReadonlyArray<string>; readonly at: number } | undefined;
  }>;
  readonly register: (row: Registration) => Effect.Effect<void>;
  readonly child: (child: string) => Effect.Effect<void>;
  readonly news: (targets: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly round: (
    gen: number,
    round: number,
    until: number,
    targets: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly report: (
    gen: number,
    round: number,
    child: string,
    earliest: number | null,
  ) => Effect.Effect<void>;
}

const earliestOf = (values: ReadonlyArray<number | null | undefined>): number | null =>
  values.reduce<number | null>(
    (a, b) => (b === null || b === undefined ? a : (earliest(a ?? undefined, b) ?? null)),
    null,
  );

const directoryObject = (deps: {
  readonly node: (path: string) => DirectoryNode;
  readonly catchUp: (
    row: Registration,
    until: number,
    targets: ReadonlyArray<string>,
  ) => Effect.Effect<CatchUpResult>;
}) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const sweepOf = state.storage.get<Sweep>("sweep");
      const jobs = yield* makeCallback("domain:directory", (job: DirectoryJob) => run(job));
      // Each step is progress, so a long sweep never exhausts the callback's retry budget.
      const schedule = (job: DirectoryJob, after: Duration.Input = 0) =>
        Effect.gen(function* () {
          const step = ((yield* state.storage.get<number>("step")) ?? 0) + 1;
          yield* state.storage.put("step", step);
          yield* jobs.schedule(job.kind, { after, payload: job, progress: step });
        });
      /** Link a node into its parent the first time something is written to it. */
      const link = (path: string) =>
        Effect.gen(function* () {
          if (path === "" || (yield* state.storage.get<boolean>("linked"))) return;
          yield* state.storage.put("linked", true);
          yield* schedule({ kind: "link", path });
        });
      /** Start a round: tell the children, then catch up this node's own instances. */
      const begin = (
        path: string,
        gen: number,
        round: number,
        until: number,
        targets: ReadonlyArray<string>,
      ) =>
        Effect.gen(function* () {
          const children = [...(yield* state.storage.list({ prefix: "c:" })).keys()].map((key) =>
            key.slice(2),
          );
          yield* state.storage.put("sweep", {
            gen,
            round,
            until,
            targets,
            children,
            told: false,
            reports: {},
            cursor: null,
            listed: false,
            pending: [],
            earliest: null,
            own: false,
            reported: false,
          } satisfies Sweep);
          yield* schedule({ kind: "round", path });
        });
      /**
       * A round is done here once the own instances and every child are: report
       * it to the parent, or at the root start the next round, a window past
       * the earliest event left, until none is.
       */
      const settle = (path: string, sweep: Sweep) =>
        Effect.gen(function* () {
          if (sweep.reported || !sweep.own) return;
          if (sweep.children.some((child) => !(child in sweep.reports))) return;
          yield* state.storage.put("sweep", { ...sweep, reported: true } satisfies Sweep);
          const next = earliestOf([sweep.earliest, ...Object.values(sweep.reports)]);
          if (path !== "") {
            const report = { gen: sweep.gen, round: sweep.round, earliest: next };
            return yield* schedule({ kind: "report", path, report });
          }
          // What the root reports to `history`: the consumers whose history has fully arrived.
          const complete = (yield* state.storage.get<Array<string>>("complete")) ?? [];
          if (next === null) {
            yield* state.storage.put("complete", [
              ...complete,
              ...sweep.targets.filter((target) => !complete.includes(target)),
            ]);
            yield* state.storage.delete("through");
          } else {
            yield* state.storage.put("through", { targets: sweep.targets, at: next });
          }
          if (next !== null)
            yield* begin(
              path,
              sweep.gen,
              sweep.round + 1,
              next + CATCH_UP_WINDOW_MS,
              sweep.targets,
            );
        });
      /** Apply `update` to the sweep if it is still the round `sweep` was read in. */
      const update = (path: string, sweep: Sweep, update: (sweep: Sweep) => Sweep) =>
        exclusively(
          Effect.gen(function* () {
            const latest = yield* sweepOf;
            if (!latest || latest.gen !== sweep.gen || latest.round !== sweep.round) return;
            const next = update(latest);
            yield* state.storage.put("sweep", next);
            yield* settle(path, next);
            return next;
          }),
        );
      /** One step of a round: tell the children, then catch up a page of own instances. */
      const step = (path: string) =>
        Effect.gen(function* () {
          let sweep = yield* sweepOf;
          if (!sweep || sweep.reported) return;
          if (!sweep.told) {
            const { gen, round, until, targets } = sweep;
            yield* Effect.forEach(
              sweep.children,
              (child) => deps.node(child).round(gen, round, until, targets),
              { concurrency: DIRECTORY_CONCURRENCY, discard: true },
            );
            const told = yield* update(path, sweep, (s) => ({ ...s, told: true }));
            if (!told) return;
            sweep = told;
          }
          if (sweep.own) return;
          const listed =
            sweep.pending.length > 0
              ? []
              : [
                  ...(yield* state.storage.list<Registration>({
                    prefix: "i:",
                    ...(sweep.cursor === null ? {} : { startAfter: sweep.cursor }),
                    limit: DIRECTORY_PAGE,
                  })).entries(),
                ];
          const batch = sweep.pending.length > 0 ? sweep.pending : listed.map(([, row]) => row);
          const { until, targets } = sweep;
          const results = yield* Effect.forEach(
            batch,
            (row) =>
              deps.catchUp(row, until, targets).pipe(Effect.map((result) => ({ row, result }))),
            { concurrency: DIRECTORY_CONCURRENCY },
          );
          const pending = results.filter(({ result }) => result.pending).map(({ row }) => row);
          const next = yield* update(path, sweep, (s) => {
            const exhausted = s.pending.length > 0 ? s.listed : listed.length < DIRECTORY_PAGE;
            return {
              ...s,
              cursor: listed.length > 0 ? listed[listed.length - 1]![0] : s.cursor,
              listed: exhausted,
              pending,
              earliest: earliestOf([s.earliest, ...results.map(({ result }) => result.next)]),
              own: exhausted && pending.length === 0,
            };
          });
          // Instances asked to be called again: back off past the ~20s a Durable Object must
          // sit idle before it leaves the code it ran before a deploy, so calls don't keep it there.
          if (next && !next.own)
            yield* schedule({ kind: "round", path }, sweep.pending.length > 0 ? "30 seconds" : 0);
        });
      const run = (
        job: DirectoryJob,
      ): Effect.Effect<void, unknown, DurableObjectState | RuntimeContext> =>
        Effect.gen(function* () {
          const parent = deps.node(parentOf(job.path));
          if (job.kind === "link") return yield* parent.child(job.path);
          if (job.kind === "news")
            return yield* parent.news((yield* state.storage.get<Array<string>>("known")) ?? []);
          if (job.kind === "round") return yield* step(job.path);
          if (job.report) {
            const { gen, round, earliest } = job.report;
            yield* parent.report(gen, round, job.path, earliest);
          }
        });
      return {
        status: () =>
          reportDefects(
            Effect.gen(function* () {
              return {
                complete: (yield* state.storage.get<Array<string>>("complete")) ?? [],
                through: yield* state.storage.get<{
                  readonly targets: ReadonlyArray<string>;
                  readonly at: number;
                }>("through"),
              };
            }),
          ),
        register: (path: string, row: Registration) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                yield* state.storage.put(`i:${row.source}:${row.id}`, row);
                yield* link(path);
              }),
            ),
          ),
        child: (path: string, child: string) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                yield* state.storage.put(`c:${child}`, true);
                yield* link(path);
              }),
            ),
          ),
        news: (path: string, targets: ReadonlyArray<string>) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                const known = (yield* state.storage.get<Array<string>>("known")) ?? [];
                const fresh = targets.filter((target) => !known.includes(target));
                if (fresh.length === 0) return;
                yield* state.storage.put("known", [...known, ...fresh]);
                if (path !== "") return yield* schedule({ kind: "news", path });
                // A new consumer: a new sweep, from a probe round that only finds the earliest event.
                yield* begin(path, ((yield* sweepOf)?.gen ?? 0) + 1, 0, 0, targets);
              }),
            ),
          ),
        round: (
          path: string,
          gen: number,
          round: number,
          until: number,
          targets: ReadonlyArray<string>,
        ) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                const sweep = yield* sweepOf;
                if (sweep && (sweep.gen > gen || (sweep.gen === gen && sweep.round >= round)))
                  return;
                yield* begin(path, gen, round, until, targets);
              }),
            ),
          ),
        report: (path: string, gen: number, round: number, child: string, at: number | null) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                const sweep = yield* sweepOf;
                if (!sweep || sweep.gen !== gen || sweep.round !== round) return;
                const next = { ...sweep, reports: { ...sweep.reports, [child]: at } };
                yield* state.storage.put("sweep", next);
                yield* settle(path, next);
              }),
            ),
          ),
      };
    });
  });

const aggregateObject = (
  kit: AggregateKit,
  directory: Directory,
  model: () => ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const outbox = yield* queue<Delivery>("outbox", kit.deliver);
      const registrations = yield* queue<Registration>("register", directory.register);
      const currentMeta = state.storage
        .get<{ state: Json | null; version: number }>("meta")
        .pipe(Effect.map((meta) => meta ?? { state: null, version: 0 }));
      const eventsAfter = (after: number) =>
        state.storage
          .list<StoredEvent>({ prefix: "event:", start: `event:${pad(after + 1)}` })
          .pipe(Effect.map((rows) => [...rows.values()]));
      // Callers run it `exclusively`.
      const commit = (id: string, command: Json, meta: Aggregate.SendMeta) =>
        Effect.gen(function* () {
          const duplicate = yield* state.storage.get<SendResult>(`receipt:${meta.commandId}`);
          if (duplicate) return { sent: duplicate, kick: false };
          const current = (yield* state.storage.get<{
            state: Json | null;
            version: number;
          }>("meta")) ?? {
            state: null,
            version: 0,
          };
          const result = yield* kit.handle({
            id,
            state: current.state,
            version: current.version,
            command,
            commandId: meta.commandId,
            context: meta.context,
            now: yield* Effect.sync(() => Date.now()),
            correlationId: meta.correlationId,
            trace: meta.trace,
            link: meta.link,
          });
          if (result._tag === "Rejected") return { sent: result as SendResult, kick: false };
          const live = routeLive(
            kit.targets,
            yield* state.storage.get<Routed>("routed"),
            current.version,
            result.version,
            result.deliveries,
          );
          const unregistered = !(yield* state.storage.get<boolean>("registered"));
          const sent: SendResult = {
            _tag: "Accepted",
            receipt: {
              stream: `${kit.name}/${id}`,
              version: result.version,
              events: result.events.map((e) => e.event),
              reply: result.reply,
            },
          };
          yield* state.storage.transaction(
            Effect.gen(function* () {
              const events: Record<string, StoredEvent> = {};
              for (const event of result.events) events[`event:${pad(event.envelope.seq)}`] = event;
              yield* state.storage.put(events);
              yield* state.storage.put("meta", {
                state: result.state,
                version: result.version,
              });
              yield* state.storage.put(`receipt:${meta.commandId}`, sent);
              yield* state.storage.put("routed", live.routed);
              yield* outbox.stage(live.deliveries);
              // Listed in the directory, so a consumer added later can reach it.
              if (unregistered) {
                yield* state.storage.put("registered", true);
                yield* registrations.stage([{ source: kit.name, id }]);
              }
            }),
          );
          if (unregistered) yield* registrations.kick;
          const committed = { state: result.state, version: result.version };
          yield* broadcast(({ key, subscription }) =>
            Effect.gen(function* () {
              // A subscriber behind this commit's first event reads the gap from storage.
              const first = result.events[0]?.envelope.seq ?? Infinity;
              const events =
                subscription.mode === "events" && subscription.cursor < first - 1
                  ? yield* eventsAfter(subscription.cursor)
                  : result.events;
              return yield* kit.push(key, subscription, committed, events);
            }),
          );
          return { sent, kick: live.deliveries.length > 0 };
        });
      const send = (id: string, command: Json, meta: Aggregate.SendMeta) =>
        Effect.gen(function* () {
          const { sent, kick } = yield* exclusively(commit(id, command, meta));
          if (kick) yield* outbox.kick;
          return sent;
        });
      const executed = (commandId: string) =>
        state.storage
          .get<SendResult>(`receipt:${commandId}`)
          .pipe(Effect.map((receipt) => receipt !== undefined));
      // Scheduled commands: one durable callback job per command id, run here
      // when due. `scheduled:<commandId>` holds the token of the job that may
      // run, or `CANCELLED` once it is cancelled, so a job cancelled or
      // replaced after the alarm claimed it does nothing. It is cleared after
      // the commit (the receipt takes over), so a retried job still runs.
      const timers = yield* makeCallback(
        "domain:schedule",
        (job: {
          readonly id: string;
          readonly command: Json;
          readonly meta: Aggregate.SendMeta;
          readonly token?: string;
        }) =>
          Effect.gen(function* () {
            const key = `scheduled:${job.meta.commandId}`;
            const kick = yield* exclusively(
              Effect.gen(function* () {
                // A job scheduled before tokens existed has none, and runs.
                if (
                  job.token !== undefined &&
                  (yield* state.storage.get<string>(key)) !== job.token
                )
                  return false;
                const { kick } = yield* commit(job.id, job.command, job.meta);
                yield* state.storage.delete(key);
                return kick;
              }),
            );
            if (kick) yield* outbox.kick;
          }),
      );
      return {
        send: (id: string, command: Json, meta: Aggregate.SendMeta) =>
          reportDefects(send(id, command, meta)),
        schedule: (id: string, command: Json, meta: Aggregate.SendMeta, due: Aggregate.Due) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                if (yield* executed(meta.commandId)) return "AlreadyExecuted" as const;
                const token = yield* Effect.sync(() => crypto.randomUUID());
                const at =
                  "at" in due ? due.at : (yield* Effect.sync(() => Date.now())) + due.afterMillis;
                yield* state.storage.put(`scheduled:${meta.commandId}`, token);
                yield* timers.schedule(meta.commandId, {
                  at,
                  payload: { id, command, meta, token },
                });
                return { at };
              }),
            ),
          ),
        unschedule: (commandId: string) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                if (yield* executed(commandId)) return "AlreadyExecuted" as const;
                const key = `scheduled:${commandId}`;
                const token = yield* state.storage.get<string>(key);
                if (token === CANCELLED) return "AlreadyCancelled" as const;
                // A job scheduled before tokens existed has a job but no token.
                if (token === undefined && (yield* timers.getStatus(commandId)) === undefined)
                  return "NotScheduled" as const;
                yield* state.storage.put(key, CANCELLED);
                yield* timers.cancel(commandId);
                return "Cancelled" as const;
              }),
            ),
          ),
        state: () => reportDefects(currentMeta),
        after: (after: number) => reportDefects(eventsAfter(after)),
        catchUp: (id: string, until: number, targets: ReadonlyArray<string>) =>
          reportDefects(
            catchUp(outbox, model(), targets, (routed) =>
              Effect.gen(function* () {
                const { version } = yield* currentMeta;
                const from = laggingFrom(kit.targets, routed, version);
                if (from === undefined) return undefined;
                const rows = yield* state.storage.list<StoredEvent>({
                  prefix: "event:",
                  start: `event:${pad(from + 1)}`,
                  limit: CATCH_UP_PAGE,
                });
                return {
                  version,
                  rows: rows.size,
                  result: kit.replay({ id, routed: routed!, rows: [...rows.values()], until }),
                };
              }),
            ),
          ),
        // A live read of this instance: accept its WebSocket, then push on every commit.
        fetch: accept((id, subscription) =>
          Effect.gen(function* () {
            const current = yield* currentMeta;
            const events =
              subscription.mode === "events" ? yield* eventsAfter(subscription.cursor) : [];
            return yield* kit.push(id, subscription, current, events);
          }),
        ),
        ...socketHandlers,
      };
    });
  });

const viewObject = (kit: ViewKit, directory: Directory, model: () => ReadonlySet<string>) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const outbox = yield* queue<Delivery>("outbox", kit.deliver);
      const registrations = yield* queue<Registration>("register", directory.register);
      const stored = state.storage
        .get<ViewSnapshot>("snapshot")
        .pipe(Effect.map((s) => s ?? emptySnapshot));
      // Built by an earlier generation of the view: it reads as empty, and starts over on write.
      const stale = (snapshot: ViewSnapshot) => (snapshot.generation ?? 0) < kit.generation;
      const read = stored.pipe(Effect.map((s) => (stale(s) ? emptySnapshot : s)));
      const reset = Effect.gen(function* () {
        if (!stale(yield* stored)) return;
        yield* clearPrefixes(["entry:", "in:"]);
        yield* state.storage.delete(["snapshot", "routed", "in-seq"]);
      });
      const entriesAfter = (after: number) =>
        stored.pipe(
          Effect.flatMap((snapshot) =>
            stale(snapshot)
              ? Effect.succeed([])
              : state.storage
                  .list<ViewEntry>({ prefix: "entry:", start: `entry:${pad(after + 1)}` })
                  .pipe(Effect.map((rows) => [...rows.values()])),
          ),
        );
      return {
        receive: (key: string, deliveries: ReadonlyArray<Delivery>) =>
          reportDefects(
            Effect.gen(function* () {
              const kick = yield* exclusively(
                Effect.gen(function* () {
                  yield* reset;
                  const before = yield* read;
                  const result = kit.apply(key, before, deliveries);
                  if (!result.changed) return false;
                  const live = routeLive(
                    kit.targets,
                    yield* state.storage.get<Routed>("routed"),
                    before.seq,
                    result.snapshot.seq,
                    result.downstream,
                  );
                  const unregistered = !(yield* state.storage.get<boolean>("registered"));
                  const rows: Record<string, ViewEntry> = {};
                  for (const entry of result.entries) rows[`entry:${pad(entry.seq)}`] = entry;
                  // The key's immutable input log: every delivery it applied, in order.
                  const accepted = deliveries.filter(
                    (d) => (before.checkpoints[d.source] ?? 0) < d.seq,
                  );
                  yield* state.storage.transaction(
                    Effect.gen(function* () {
                      const inputs = (yield* state.storage.get<number>("in-seq")) ?? 0;
                      const log: Record<string, Delivery> = {};
                      accepted.forEach((delivery, index) => {
                        log[`in:${pad(inputs + index + 1)}`] = delivery;
                      });
                      yield* state.storage.put(log);
                      yield* state.storage.put("in-seq", inputs + accepted.length);
                      yield* state.storage.put("snapshot", result.snapshot);
                      if (result.entries.length > 0) yield* state.storage.put(rows);
                      yield* state.storage.put("routed", live.routed);
                      yield* outbox.stage(live.deliveries);
                      // Listed in the directory, so a consumer of this view added later can reach it.
                      if (unregistered) {
                        yield* state.storage.put("registered", true);
                        yield* registrations.stage([{ source: kit.name, id: key }]);
                      }
                    }),
                  );
                  if (unregistered) yield* registrations.kick;
                  yield* broadcast(({ key, subscription }) =>
                    Effect.gen(function* () {
                      // A subscriber behind this commit's first entry reads the gap from storage.
                      const first = result.entries[0]?.seq ?? Infinity;
                      const entries =
                        subscription.mode === "events" && subscription.cursor < first - 1
                          ? yield* entriesAfter(subscription.cursor)
                          : result.entries;
                      return yield* kit.push(key, subscription, result.snapshot, entries);
                    }),
                  );
                  return live.deliveries.length > 0;
                }).pipe(kit.observe(key, deliveries)),
              );
              if (kick) yield* outbox.kick;
            }),
          ),
        read: () => reportDefects(read),
        after: (after: number) => reportDefects(entriesAfter(after)),
        catchUp: (key: string, until: number, targets: ReadonlyArray<string>) =>
          reportDefects(
            catchUp(outbox, model(), targets, (routed) =>
              Effect.gen(function* () {
                yield* reset;
                const { seq } = yield* read;
                const from = laggingFrom(kit.targets, routed, seq);
                if (from === undefined) return undefined;
                const rows = yield* state.storage.list<ViewEntry>({
                  prefix: "entry:",
                  start: `entry:${pad(from + 1)}`,
                  limit: CATCH_UP_PAGE,
                });
                return {
                  version: seq,
                  rows: rows.size,
                  result: kit.replay({ id: key, routed: routed!, rows: [...rows.values()], until }),
                };
              }),
            ),
          ),
        // A live read of this key: accept its WebSocket, then push on every commit.
        fetch: accept((key, subscription) =>
          Effect.gen(function* () {
            const snapshot = yield* read;
            const entries =
              subscription.mode === "events" ? yield* entriesAfter(subscription.cursor) : [];
            return yield* kit.push(key, subscription, snapshot, entries);
          }),
        ),
        ...socketHandlers,
      };
    });
  });

const policyObject = (kit: PolicyKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const inbox = yield* queue<Delivery>("inbox", kit.run);
      return {
        receive: (delivery: Delivery) =>
          reportDefects(
            Effect.gen(function* () {
              const id = `${delivery.source}:${delivery.seq}`;
              const accepted = yield* exclusively(
                state.storage.transaction(
                  Effect.gen(function* () {
                    if (yield* state.storage.get(`seen:${id}`)) return false;
                    yield* state.storage.put(`seen:${id}`, true);
                    yield* inbox.stage([delivery]);
                    return true;
                  }),
                ),
              );
              if (accepted) yield* inbox.kick;
            }),
          ),
      };
    });
  });

/** The stored progress of one projection key. */
interface ProjectionMeta {
  readonly key: string | null;
  /** Inputs accepted into the log. */
  readonly accepted: number;
  /** Inputs handled. */
  readonly processed: number;
  /** The last accepted `seq` per source: duplicates are dropped on arrival. */
  readonly intake: Readonly<Record<string, number>>;
  /** The last handled `seq` per source. */
  readonly checkpoints: Readonly<Record<string, number>>;
  /** The projection's generation the log was built by: an earlier one starts over. */
  readonly generation?: number;
}

const emptyProjectionMeta: ProjectionMeta = {
  key: null,
  accepted: 0,
  processed: 0,
  intake: {},
  checkpoints: {},
};

/** How long a failed or interrupted run waits before it is retried. */
const PROJECTION_RETRY_MS = 10_000;

const projectionObject = (kit: ProjectionKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      // A log built by an earlier generation of the projection reads as empty.
      const readMeta = state.storage
        .get<ProjectionMeta>("meta")
        .pipe(
          Effect.map((meta) =>
            meta === undefined || (meta.generation ?? 0) < kit.generation
              ? { ...emptyProjectionMeta, generation: kit.generation }
              : meta,
          ),
        );
      /** Start a log built by an earlier generation over. */
      const reset = Effect.gen(function* () {
        const meta = yield* state.storage.get<ProjectionMeta>("meta");
        if (meta === undefined || (meta.generation ?? 0) >= kit.generation) return;
        yield* clearPrefixes(["in:"]);
        yield* state.storage.delete("meta");
      });
      const size = kit.options.batch?.size ?? 1;
      const waitMillis = kit.options.batch?.waitMillis ?? 0;
      const lease = "drain-lease";
      const acquire = exclusively(
        Effect.gen(function* () {
          const held = yield* state.storage.get<number>(lease);
          if (held !== undefined && held > Date.now()) return false;
          yield* state.storage.put(lease, Date.now() + LEASE_MS);
          return true;
        }),
      );
      // Re-run the drain later: when a short batch has waited long enough, or after a failure.
      let wake: (at: number) => Effect.Effect<void> = () => Effect.void;
      const drain: Effect.Effect<void> = Effect.gen(function* () {
        if (!(yield* acquire)) return;
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            while (true) {
              const meta = yield* readMeta;
              if (meta.key === null || meta.processed >= meta.accepted) return;
              const rows = yield* state.storage.list<Accepted>({
                prefix: "in:",
                start: `in:${pad(meta.processed + 1)}`,
                limit: size,
              });
              const run = [...rows.values()];
              if (run.length === 0) return;
              if (run.length < size && waitMillis > 0 && Date.now() - run[0]!.at < waitMillis) {
                return yield* wake(run[0]!.at + waitMillis);
              }
              yield* kit.run(meta.key, run);
              yield* exclusively(
                Effect.gen(function* () {
                  const current = yield* readMeta;
                  const handled: Record<string, number> = {};
                  for (const { delivery } of run) {
                    handled[delivery.source] = Math.max(
                      handled[delivery.source] ?? 0,
                      delivery.seq,
                    );
                  }
                  yield* state.storage.put("meta", {
                    ...current,
                    processed: run[run.length - 1]!.position,
                    checkpoints: mergeCheckpoints(current.checkpoints, handled),
                  } satisfies ProjectionMeta);
                }),
              );
            }
          }),
        );
        yield* state.storage.delete(lease).pipe(Effect.ignore);
        if (exit._tag === "Failure") {
          yield* Effect.logError(`projection ${kit.name} failed; retrying`, exit.cause);
          yield* wake(Date.now() + PROJECTION_RETRY_MS);
        }
      }) as Effect.Effect<void>;
      const callback = yield* makeCallback("domain:projection", () => drain);
      wake = (at) =>
        callback.schedule("drain", { at, payload: {} }).pipe(Effect.ignore) as Effect.Effect<void>;
      return {
        receive: (key: string, delivery: Delivery) =>
          reportDefects(
            Effect.gen(function* () {
              const sent = delivery.target.generation ?? 0;
              // For an earlier generation: sent by an instance still on older code.
              if (sent < kit.generation) return;
              // Sent by newer code: fail, so the sender retries once this instance runs it.
              if (sent > kit.generation) {
                return yield* Effect.die(
                  new Error(`${kit.name} received generation ${sent} but runs ${kit.generation}`),
                );
              }
              yield* exclusively(reset);
              const accepted = yield* exclusively(
                state.storage.transaction(
                  Effect.gen(function* () {
                    const meta = yield* readMeta;
                    if ((meta.intake[delivery.source] ?? 0) >= delivery.seq) return false;
                    const position = meta.accepted + 1;
                    yield* state.storage.put(`in:${pad(position)}`, {
                      position,
                      delivery,
                      at: Date.now(),
                    } satisfies Accepted);
                    yield* state.storage.put("meta", {
                      ...meta,
                      key,
                      accepted: position,
                      intake: { ...meta.intake, [delivery.source]: delivery.seq },
                    } satisfies ProjectionMeta);
                    // The backstop: handled even if this instance dies before the drain runs.
                    yield* callback.schedule("drain", {
                      after: `${Math.max(waitMillis, PROJECTION_RETRY_MS)} millis`,
                      payload: {},
                    });
                    return true;
                  }),
                ),
              );
              if (accepted) yield* state.waitUntil(drain.pipe(Effect.ignoreCause));
            }),
          ),
        checkpoints: () => reportDefects(readMeta.pipe(Effect.map((meta) => meta.checkpoints))),
      };
    });
  });

const streamObject = (kit: StreamKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const readMeta = state.storage
        .get<StreamMeta>("meta")
        .pipe(Effect.map((meta) => meta ?? emptyStreamMeta));
      const entriesAfter = (after: number) =>
        state.storage
          .list<StreamEntry>({ prefix: "entry:", start: `entry:${pad(after + 1)}` })
          .pipe(Effect.map((rows) => [...rows.values()]));
      const latest = (meta: StreamMeta) =>
        meta.seq === 0
          ? Effect.succeed(undefined)
          : state.storage.get<StreamEntry>(`entry:${pad(meta.seq)}`);
      return {
        append: (key: string, write: StreamWrite) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                const meta = yield* readMeta;
                if (!isAfter(write.origin, meta.origin)) return;
                const added: Array<StreamEntry> = write.events.map((event, index) => {
                  const seq = meta.seq + index + 1;
                  return {
                    seq,
                    event,
                    envelope: {
                      id: key,
                      stream: `${kit.name}/${key}`,
                      seq,
                      at: write.at,
                      commandId: write.commandId,
                    },
                  };
                });
                const next: StreamMeta = {
                  seq: meta.seq + added.length,
                  origin: write.origin,
                  checkpoints: mergeCheckpoints(meta.checkpoints, {
                    [write.source]: write.sourceSeq,
                  }),
                };
                yield* state.storage.transaction(
                  Effect.gen(function* () {
                    const rows: Record<string, StreamEntry> = {};
                    for (const entry of added) rows[`entry:${pad(entry.seq)}`] = entry;
                    if (added.length > 0) yield* state.storage.put(rows);
                    yield* state.storage.put("meta", next);
                  }),
                );
                if (added.length === 0) return;
                yield* broadcast(({ key, subscription }) =>
                  Effect.gen(function* () {
                    // A subscriber behind this append's first entry reads the gap from storage.
                    const entries =
                      subscription.mode === "events" && subscription.cursor < added[0]!.seq - 1
                        ? yield* entriesAfter(subscription.cursor)
                        : added;
                    return yield* kit.push(
                      key,
                      subscription,
                      next,
                      entries,
                      added[added.length - 1],
                    );
                  }),
                );
              }),
            ),
          ),
        advance: (checkpoints: Readonly<Record<string, number>>) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                const meta = yield* readMeta;
                yield* state.storage.put("meta", {
                  ...meta,
                  checkpoints: mergeCheckpoints(meta.checkpoints, checkpoints),
                } satisfies StreamMeta);
              }),
            ),
          ),
        read: () => reportDefects(readMeta),
        after: (after: number) => reportDefects(entriesAfter(after)),
        // A live read of this key: accept its WebSocket, then push on every append.
        fetch: accept((key, subscription) =>
          Effect.gen(function* () {
            const meta = yield* readMeta;
            const entries =
              subscription.mode === "events" ? yield* entriesAfter(subscription.cursor) : [];
            return yield* kit.push(key, subscription, meta, entries, yield* latest(meta));
          }),
        ),
        ...socketHandlers,
      };
    });
  });

/** How often a subscription re-reads the Durable Object that owns a key. */
const POLL = Schedule.spaced("300 millis");

/** Entries after a cursor, then new ones, by polling the object that owns them. */
const pollAfter = <A>(
  from: number,
  read: (cursor: number) => Effect.Effect<ReadonlyArray<A>>,
  seqOf: (entry: A) => number,
): Stream.Stream<A> =>
  Stream.suspend(() => {
    let first = true;
    return Stream.paginate(from, (cursor: number) => {
      const poll = read(cursor);
      const next = first ? poll : Effect.delay(poll, "300 millis");
      first = false;
      return Effect.map(
        next,
        (fresh) =>
          [
            fresh,
            Option.some(fresh.length > 0 ? seqOf(fresh[fresh.length - 1]!) : cursor),
          ] as const,
      );
    });
  });

/** The aggregates, views, policies, projections and streams, each on its own Durable Object class. */
const DurableObjectPlatform: Layer.Layer<Platform, never, Worker> = Layer.effect(
  Platform,
  Effect.gen(function* () {
    // Factories run while the Domain's Layer is built, inside the Worker's
    // init phase; declaring a Durable Object needs that context.
    const init = yield* captureContext<Worker>();
    const inInit = <A, E>(effect: Effect.Effect<A, E, Worker>): Effect.Effect<A, E> =>
      Effect.provide(effect, init);

    // The directory of source instances, and how to catch one up, by source name.
    const catchUps = new Map<
      string,
      (id: string, until: number, targets: ReadonlyArray<string>) => Effect.Effect<CatchUpResult>
    >();
    // Every consumer in the model this isolate runs, set once the model is built.
    let model: ReadonlySet<string> = new Set();
    const current = () => model;
    let directoryNamespace: Namespace | undefined;
    const node = (path: string): DirectoryNode => {
      const stub = () => directoryNamespace!.getByName(`node:${path}`);
      return {
        status: () => unwrapDefects(stub().status()),
        register: (row) => unwrapDefects(stub().register(path, row)),
        child: (child) => unwrapDefects(stub().child(path, child)),
        news: (targets) => unwrapDefects(stub().news(path, targets)),
        round: (gen, round, until, targets) =>
          unwrapDefects(stub().round(path, gen, round, until, targets)),
        report: (gen, round, child, earliest) =>
          unwrapDefects(stub().report(path, gen, round, child, earliest)),
      };
    };
    directoryNamespace = yield* inInit(
      declare(
        "DomainDirectory",
        directoryObject({
          node,
          catchUp: (row, until, targets) =>
            catchUps.get(row.source)?.(row.id, until, targets) ??
            // A source no longer in the model has nothing to catch up.
            Effect.succeed({ next: undefined, pending: false }),
        }),
      ),
    );
    const directory: Directory = { register: (row) => node(leafOf(row)).register(row) };

    // The first Domain call in each isolate tells one random directory node of
    // the model's consumers: a deploy that adds one starts its catch-up.
    let news: Effect.Effect<void> | undefined;
    const announce = Effect.suspend(() => {
      const pending = news;
      if (pending === undefined) return Effect.void;
      news = undefined;
      return pending.pipe(
        Effect.timeout("5 seconds"),
        Effect.catchCause(() =>
          Effect.sync(() => {
            news = pending;
          }),
        ),
      );
    });

    return Platform.of({
      aggregate: (aggregate, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(
              `${aggregate.aggregateName}Aggregate`,
              aggregateObject(kit, directory, current),
            );
            catchUps.set(aggregate.aggregateName, (id, until, targets) =>
              unwrapDefects(namespace.getByName(id).catchUp(id, until, targets)),
            );
            return {
              send: (id, command, meta) =>
                announce.pipe(
                  Effect.andThen(
                    unwrapDefects<SendResult>(namespace.getByName(id).send(id, command, meta)),
                  ),
                ),
              // The object answers with a tag (RPC loses typed failures); fail with it here.
              schedule: (id, command, meta, due) =>
                unwrapDefects<{ readonly at: number } | "AlreadyExecuted">(
                  namespace.getByName(id).schedule(id, command, meta, due),
                ).pipe(
                  Effect.flatMap((outcome) =>
                    outcome === "AlreadyExecuted"
                      ? Effect.fail(
                          new AlreadyExecuted({
                            aggregate: aggregate.aggregateName,
                            id,
                            commandId: meta.commandId,
                          }),
                        )
                      : Effect.succeed(outcome.at),
                  ),
                ),
              unschedule: (id, commandId) =>
                unwrapDefects<
                  "Cancelled" | "AlreadyCancelled" | "AlreadyExecuted" | "NotScheduled"
                >(namespace.getByName(id).unschedule(commandId)).pipe(
                  Effect.flatMap(
                    (
                      outcome,
                    ): Effect.Effect<void, AlreadyExecuted | AlreadyCancelled | NotScheduled> => {
                      const fields = { aggregate: aggregate.aggregateName, id, commandId };
                      if (outcome === "AlreadyExecuted")
                        return Effect.fail(new AlreadyExecuted(fields));
                      if (outcome === "AlreadyCancelled")
                        return Effect.fail(new AlreadyCancelled(fields));
                      if (outcome === "NotScheduled") return Effect.fail(new NotScheduled(fields));
                      return Effect.void;
                    },
                  ),
                ),
              state: (id) =>
                announce.pipe(
                  Effect.andThen(
                    unwrapDefects<{ state: Json | null; version: number }>(
                      namespace.getByName(id).state(),
                    ),
                  ),
                ),
              // Streamed responses poll; WebSocket reads (`connect`) are pushed on commit.
              changes: (id) =>
                Stream.fromEffectSchedule(
                  unwrapDefects<{ state: Json | null; version: number }>(
                    namespace.getByName(id).state(),
                  ),
                  POLL,
                ).pipe(Stream.changesWith((a, b) => a.version === b.version)),
              tail: (id, from) =>
                pollAfter(
                  from,
                  (cursor) =>
                    unwrapDefects<ReadonlyArray<StoredEvent>>(
                      namespace.getByName(id).after(cursor),
                    ),
                  (event) => event.envelope.seq,
                ),
              connect: connectTo(namespace),
            };
          }),
        ),
      view: (view, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(
              `${view.viewName}View`,
              viewObject(kit, directory, current),
            );
            catchUps.set(view.viewName, (key, until, targets) =>
              unwrapDefects(namespace.getByName(key).catchUp(key, until, targets)),
            );
            const read = (key: string) =>
              announce.pipe(
                Effect.andThen(unwrapDefects<ViewSnapshot>(namespace.getByName(key).read())),
              );
            const after = (key: string, cursor: number) =>
              unwrapDefects<ReadonlyArray<ViewEntry>>(namespace.getByName(key).after(cursor));
            return {
              receive: (key, deliveries) =>
                unwrapDefects(namespace.getByName(key).receive(key, deliveries)),
              read,
              // Streamed responses poll; WebSocket reads (`connect`) are pushed on commit.
              changes: (key) =>
                Stream.fromEffectSchedule(read(key), POLL).pipe(
                  Stream.changesWith((a, b) => a.version === b.version),
                ),
              list: (key) => after(key, 0),
              connect: connectTo(namespace),
              tail: (key, from) =>
                Stream.suspend(() => {
                  let first = true;
                  return Stream.paginate(from, (cursor: number) => {
                    const poll = after(key, cursor);
                    const next = first ? poll : Effect.delay(poll, "300 millis");
                    first = false;
                    return Effect.map(
                      next,
                      (fresh) =>
                        [
                          fresh,
                          Option.some(fresh.length > 0 ? fresh[fresh.length - 1]!.seq : cursor),
                        ] as const,
                    );
                  });
                }),
            };
          }),
        ),
      projection: (projection, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(
              `${projection.projectionName}Projection`,
              projectionObject(kit),
            );
            return {
              receive: (delivery) =>
                unwrapDefects(namespace.getByName(delivery.key).receive(delivery.key, delivery)),
              checkpoints: (key) =>
                unwrapDefects<Readonly<Record<string, number>>>(
                  namespace.getByName(key).checkpoints(),
                ),
            };
          }),
        ),
      stream: (stream, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(`${stream.streamName}Stream`, streamObject(kit));
            const read = (key: string) =>
              unwrapDefects<StreamMeta>(namespace.getByName(key).read());
            const after = (key: string, cursor: number) =>
              unwrapDefects<ReadonlyArray<StreamEntry>>(namespace.getByName(key).after(cursor));
            return {
              append: (key, write) => unwrapDefects(namespace.getByName(key).append(key, write)),
              advance: (key, checkpoints) =>
                unwrapDefects(namespace.getByName(key).advance(checkpoints)),
              read,
              // Streamed responses poll; WebSocket reads (`connect`) are pushed on append.
              changes: (key) =>
                Stream.fromEffectSchedule(read(key), POLL).pipe(
                  Stream.changesWith((a, b) => a.seq === b.seq),
                ),
              list: (key) => after(key, 0),
              tail: (key, from) =>
                pollAfter(
                  from,
                  (cursor) => after(key, cursor),
                  (e) => e.seq,
                ),
              connect: connectTo(namespace),
            };
          }),
        ),
      history: (target) =>
        node("")
          .status()
          .pipe(
            Effect.map(({ complete, through }) => ({
              complete: complete.includes(target),
              through: through?.targets.includes(target) ? through.at : undefined,
            })),
          ),
      start: (targets) =>
        Effect.sync(() => {
          model = new Set(targets);
          if (targets.length === 0) return;
          news = Effect.suspend(() => {
            // A random node two levels down: the burst after a deploy spreads over 256 of them.
            const path = Math.floor(Math.random() * 256)
              .toString(16)
              .padStart(2, "0");
            return node(path).news(targets);
          });
        }),
      policy: (policy, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(`${policy.policyName}Policy`, policyObject(kit));
            return {
              receive: (delivery) =>
                unwrapDefects(namespace.getByName(delivery.key).receive(delivery)),
            };
          }),
        ),
    });
  }),
);

/**
 * Host a domain model on Cloudflare Durable Objects. Every aggregate, view
 * and policy becomes a Durable Object class on the host Worker, declared
 * while the model's Layer is built, so there are no bindings to write. One
 * instance per aggregate id, per view key, and per policy and source.
 *
 * Commands to one instance run one at a time, and their events, state and
 * outbox commit together. Deliveries to views and policies are at least once
 * and in order per source, and survive restarts. Live reads over
 * `Domain.protocolWebSocket` are WebSockets to the object that owns the key,
 * pushed on every commit; the object hibernates in between.
 *
 * A view or projection added in a later deploy receives the history recorded
 * before it. Every instance lists itself in a directory of Durable Objects,
 * and the first Domain call in each isolate after the deploy starts a catch-up
 * that runs over the directory in alarms, an hour of history at a time.
 *
 * ### Hosting on Cloudflare
 * **Example:** A Worker serving an Api
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 * import { CustomerApi } from "./CustomerApi.ts";
 * import { SessionLive } from "./Session.ts";
 *
 * const BankLive = SessionLive.pipe(
 *   Layer.provideMerge(Bank.layer(BankPolicies)),
 *   Layer.provide(DomainCloudflare.DurableObjects),
 * );
 *
 * export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
 *   "BankWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* CustomerApi;
 *     return { fetch: api.fetch };
 *   }).pipe(Effect.provide(BankLive)),
 * ) {}
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export const DurableObjects: Layer.Layer<Platform | WorkflowEngine.WorkflowEngine, never, Worker> =
  Layer.merge(DurableObjectPlatform, DurableObjectEngine);
