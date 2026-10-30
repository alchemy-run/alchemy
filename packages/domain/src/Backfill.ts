import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  type ReplayInput,
  type ReplayResult,
  type Routed,
  routeLive,
  targetId,
} from "./CatchUp.ts";
import type { Delivery } from "./Platform.ts";

/**
 * Backfill: how a view or projection added after its sources recorded events
 * (or rebuilt by bumping its version) receives their history, in timestamp
 * order, without a central coordinator.
 *
 * Three roles, each a durable object that owns its own storage:
 *
 * - **Directory nodes** form a tree (fan-out 16) that lists every source
 *   instance. A sweep for a consumer (a "target") runs down the tree and
 *   reports back up, in three phases: discover, ready, complete.
 * - **Sources** (aggregate instances, and view keys other consumers read) scan
 *   their history once through the target's routing, index which events go to
 *   which consumer key, and tell each key it has them as a source. Keys pull
 *   from them, and when a key has pulled everything, the source switches it to
 *   live delivery in the same step.
 * - A consumer keyed by its source (a view per account) skips all of that: its
 *   leaf tells each key to start, and the key reads its source's raw log,
 *   routes it with its own code and applies it. A source serves its log on any
 *   code, so the backfill never waits for an existing instance to run the
 *   deployed code; only the switch to live delivery does, and the key's
 *   history is complete before it.
 * - **Consumer keys** (view keys, projection keys) buffer what they receive
 *   ordered by `(at, stream, seq)` and apply the earliest event whenever every
 *   source still being pulled has an event buffered. That is a k-way merge of
 *   their own sources: a total order by timestamp, local to each key.
 *
 * Every step does a bounded amount of work, records its progress before it
 * answers, and is idempotent, so a crash, a retry or a redeploy at any point
 * resumes where it left off. Every continuation is a scheduled job, never a
 * nested call.
 *
 * @internal
 */

// ---------------------------------------------------------------- runtime

/** A key-ordered store, as a Durable Object's storage is. */
export interface Storage {
  readonly get: <A>(key: string) => Effect.Effect<A | undefined>;
  readonly put: (entries: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
  readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Entries under `prefix`, in key order, after `startAfter`. */
  readonly list: <A>(options: {
    readonly prefix: string;
    readonly startAfter?: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<readonly [string, A]>>;
  /** Run `effect` with every other call on this object held back. */
  readonly exclusive: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

/** Durable, at-least-once jobs on one object: a job with the same id replaces a pending one. */
export interface Jobs {
  /**
   * Run job `id` after `afterMillis`. The earliest request wins: a job already due
   * sooner isn't postponed (every job is idempotent, so running early is safe),
   * including one asked for while that job runs.
   */
  readonly schedule: (id: string, afterMillis: number) => Effect.Effect<void>;
}

/** An instance listed in the directory: its source (aggregate or view) and id. */
export interface SourceRef {
  readonly source: string;
  readonly id: string;
}

/** How far a sweep for a target has got, as a node knows it. */
export type Phase = "unknown" | "discover" | "ready" | "complete";

/**
 * What a node needs to know of a consumer to sweep for it. The deploy that adds
 * the consumer sends it with the announcement and every sweep carries it, so a
 * node still on the code before that deploy sweeps the same way.
 */
export interface Plan {
  /** The sources (aggregates and views, by name) the consumer reads: the subtrees to sweep (all if absent). */
  readonly sources?: ReadonlyArray<string>;
  /** Each key reads one instance, the one with its own id: the leaf starts the keys itself. */
  readonly singleSource: boolean;
}

export interface NodeRpc {
  readonly register: (path: string, ref: SourceRef) => Effect.Effect<void>;
  readonly child: (path: string, child: string) => Effect.Effect<void>;
  readonly news: (
    path: string,
    targets: ReadonlyArray<string>,
    plans: Readonly<Record<string, Plan>>,
  ) => Effect.Effect<void>;
  readonly sweep: (
    path: string,
    target: string,
    phase: "discover" | "ready" | "complete",
    plan: Plan | undefined,
  ) => Effect.Effect<void>;
  readonly report: (
    path: string,
    target: string,
    phase: "discover" | "ready",
    child: string,
    /** Why the child took as long as it did: see {@link Hop}. */
    trail?: ReadonlyArray<Hop>,
  ) => Effect.Effect<void>;
  readonly settled: (path: string, target: string, ref: SourceRef) => Effect.Effect<void>;
  readonly phase: (path: string, target: string) => Effect.Effect<Phase>;
  readonly status: (path: string) => Effect.Effect<Status>;
}

/** What a source answers to `scan`. */
export type ScanResult =
  /** Its code doesn't know the target yet: call again once it runs the deployed code. */
  | "stale"
  /** It has more history to scan: call again. */
  | "more"
  /** Every key it feeds knows it as a source. */
  | "discovered";

export interface SourceRpc {
  readonly scan: (ref: SourceRef, target: string) => Effect.Effect<ScanResult>;
  /** Tell its keys discovery is complete. */
  /** `reportTo`: the directory node to tell when every key it feeds has gone live. */
  readonly ready: (ref: SourceRef, target: string, reportTo: string) => Effect.Effect<ReadyResult>;
  readonly pull: (
    ref: SourceRef,
    target: string,
    key: string,
    after: number,
  ) => Effect.Effect<Pulled>;
  /**
   * Its stored rows (events, or a view key's entries) after `after`, as stored.
   * Any code answers it: nothing in it depends on the consumer asking.
   */
  readonly log: (
    ref: SourceRef,
    after: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<unknown>>;
  /**
   * Route `target` live from now on, if the key has read every row up to its
   * version (`through`): `"more"` if rows were added since, `"stale"` on code
   * without the target.
   */
  readonly handoff: (
    ref: SourceRef,
    target: string,
    key: string,
    through: number,
  ) => Effect.Effect<Handoff>;
}

/** What a source answers to `handoff`. */
export type Handoff = "live" | "more" | "stale";

/** A page a key pulled from a source. */
export interface Pulled {
  readonly deliveries: ReadonlyArray<Delivery>;
  /** The source switched the key to live delivery: nothing more to pull. */
  readonly live: boolean;
  /**
   * The last seq the source read for this page: the key's cursor moves past it,
   * even when those rows held nothing for the key.
   */
  readonly through?: number;
  /**
   * Nothing followed this page when it was read: the key pulls again at once to
   * switch to live, rather than wait until its merge runs out of this source.
   */
  readonly end?: boolean;
}

export interface ConsumerRpc {
  readonly source: (
    target: string,
    key: string,
    stream: string,
    ref: SourceRef,
  ) => Effect.Effect<void>;
  readonly ready: (target: string, key: string) => Effect.Effect<void>;
  /**
   * Start a key of a consumer keyed by its source: it reads `ref`'s log itself.
   * `"settled"` when it has its history already.
   */
  readonly start: (
    target: string,
    key: string,
    ref: SourceRef,
  ) => Effect.Effect<"pending" | "settled">;
}

/** How the roles reach each other. */
export interface Network {
  readonly node: NodeRpc;
  readonly source: SourceRpc;
  readonly consumer: ConsumerRpc;
}

/** What the root reports: the targets whose history has fully arrived, and those still running. */
/**
 * One node's part of a phase, in epoch milliseconds: when it began, when it had
 * handled its own instances, when the last of them settled (`ready`), and when
 * it was done, with the child it waited for last. A node's report carries its
 * hop and that child's trail, so the root's trail is the phase's critical path.
 */
export interface Hop {
  readonly path: string;
  readonly begin: number;
  readonly own?: number;
  readonly settled?: number;
  readonly end: number;
  readonly last?: string;
  readonly lastAt?: number;
}

export interface Status {
  readonly complete: ReadonlyArray<string>;
  readonly running: ReadonlyArray<string>;
}

/** Tuning, in rows and calls per step. */
export interface Limits {
  /** History rows a source scans, or a key pulls, per call. */
  readonly page: number;
  /** Source instances a directory node handles per step, and calls it makes at once. */
  readonly nodePage: number;
  readonly concurrency: number;
  /** Buffered rows a key applies per step. */
  readonly apply: number;
  /** How long to wait before calling a stale source again, in milliseconds. */
  readonly staleRetryMillis: number;
  /**
   * How long before the first retry of a refused or failed call, in milliseconds:
   * right after a deploy its new code may not have reached the object yet.
   */
  readonly firstRetryMillis: number;
  /** How long a key without sources waits before asking whether discovery is complete again. */
  readonly pollMillis: number;
  /**
   * Instances a directory node lists before it splits into 16 children, so every
   * node's share of a sweep stays bounded and the tree grows as log16 of the instances.
   */
  readonly leafSize: number;
  /** The depth instances list themselves at, before any split. */
  readonly depth: number;
}

/**
 * The depth instances list themselves at: 256 leaves, each splitting once it
 * fills. Wide enough that first commits spread over many objects, few enough
 * that a small Domain's directory stays small (every node costs a sweep).
 */
export const DEPTH = 2;

export const defaultLimits: Limits = {
  page: 100,
  nodePage: 25,
  concurrency: 5,
  apply: 200,
  staleRetryMillis: 30_000,
  firstRetryMillis: 1_000,
  pollMillis: 5_000,
  leafSize: 256,
  depth: DEPTH,
};

// ---------------------------------------------------------------- keys

const enc = encodeURIComponent;
const pad = (n: number, width: number) => String(Math.max(0, Math.floor(n))).padStart(width, "0");

/** Log a protocol step at debug level (`backfill <step>` and a JSON body), to follow a backfill. */
const trace = (step: string, fields: Record<string, unknown>) =>
  Effect.logDebug(`backfill ${step} ${JSON.stringify(fields)}`);

/**
 * The directory has one subtree per source (`Account:`, `Deposits:`), so a sweep
 * for a consumer walks only the sources it reads. Within a subtree a node's path
 * is the source, a colon and a prefix of the instance's hash: `Account:a3`.
 */
export const leafOf = (ref: SourceRef, depth: number = DEPTH): string =>
  `${ref.source}:${hashOf(ref).slice(0, depth)}`;

/** The hash digits of a path: its depth within its source's subtree. */
const digitsOf = (path: string) => path.slice(path.indexOf(":") + 1);

/** The source a node's subtree lists, or `undefined` for the root (and news relays). */
export const sourceOfPath = (path: string): string | undefined => {
  const colon = path.indexOf(":");
  return colon < 0 ? undefined : path.slice(0, colon);
};

/** The FNV-1a hash of an instance's source and id, as 8 hex digits: its path in the tree. */
const hashOf = ({ source, id }: SourceRef): string => {
  let hash = 0x811c9dc5;
  for (const char of `${source}/${id}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // FNV-1a barely moves the high bits for ids that differ in their last characters
  // (`b0`, `b1`, …): mix them in (murmur3's finalizer), so the tree fills evenly.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** The child of a split node that lists an instance: one more hex digit of its hash. */
const childFor = (path: string, ref: SourceRef) =>
  `${ref.source}:${hashOf(ref).slice(0, digitsOf(path).length + 1)}`;

/** A source's subtree (`Account:`) hangs off the root; a news relay (`a3`) climbs by digit. */
const parentOf = (path: string) => (path.endsWith(":") ? "" : path.slice(0, -1));
const refKey = (ref: SourceRef) => `${enc(ref.source)}:${enc(ref.id)}`;

/** A buffered delivery's place in a key's merge: timestamp, then stream, then seq. */
export const orderKey = (target: string, delivery: Delivery) =>
  `bf:b:${enc(target)}:${pad(delivery.envelope.at, 15)}:${enc(delivery.source)}:${pad(delivery.seq, 12)}`;

// ---------------------------------------------------------------- outbox

type Message =
  | {
      readonly kind: "source";
      readonly target: string;
      readonly key: string;
      readonly stream: string;
      readonly ref: SourceRef;
    }
  | { readonly kind: "ready"; readonly target: string; readonly key: string }
  | {
      readonly kind: "settled";
      readonly target: string;
      readonly ref: SourceRef;
      /** The node that readied it; absent on rows staged by earlier code. */
      readonly to?: string;
    };

const OUTBOX_LEASE_MS = 60_000;

/**
 * How long before a failed send is tried again: past the ~20s a Durable Object
 * must sit idle before it leaves the code it ran before a deploy, so retries to
 * one still on older code don't keep it there.
 */
const RETRY_MS = 30_000;

/** How long a key that is waiting to be told discovery is complete waits before asking. */
const SAFETY_POLL_MS = 60_000;

/**
 * Run a job again after a refusal or a failure, waiting twice as long each time:
 * from `firstRetryMillis`, so a one-off failure (or a deploy's code still on its
 * way to an object) costs seconds, up to four times the slow pace. Cloudflare moves
 * a Durable Object to new code when it is evicted after sitting idle: calls at a
 * short, fixed pace would keep one on older code, so the gaps grow until it can.
 */
const makeRetry = (storage: Storage, jobs: Jobs, limits: Limits) => {
  const key = (id: string) => `bf:retry:${id}`;
  return {
    later: (id: string, slowMillis: number) =>
      Effect.gen(function* () {
        const tries = (yield* storage.get<number>(key(id))) ?? 0;
        yield* storage.put({ [key(id)]: tries + 1 });
        yield* jobs.schedule(
          id,
          Math.min(slowMillis * 4, limits.firstRetryMillis * 2 ** Math.min(tries, 20)),
        );
      }),
    /** The job went through: its next failure retries soon again. */
    clear: (id: string) =>
      Effect.gen(function* () {
        if ((yield* storage.get(key(id))) !== undefined) yield* storage.delete([key(id)]);
      }),
  };
};
type Retry = ReturnType<typeof makeRetry>;

/** A target's generation: `view:Name#2` is 2. */
const generationOf = (target: string) => Number(/#(\d+)$/.exec(target)?.[1] ?? 0);

/** Refused by an instance still on older code; the sender tries again later. */
class Stale extends Error {
  override readonly name = "Stale";
}

/**
 * A source's durable outbox of control messages: staged with the state change
 * that produced them, sent in order, deleted once sent. One flush at a time.
 */
const outbox = (storage: Storage, jobs: Jobs, net: Network, depth: number, retry: Retry) => {
  const send = (message: Message): Effect.Effect<void> => {
    switch (message.kind) {
      case "source":
        return net.consumer.source(message.target, message.key, message.stream, message.ref);
      case "ready":
        return net.consumer.ready(message.target, message.key);
      case "settled":
        return net.node.settled(
          message.to ?? leafOf(message.ref, depth),
          message.target,
          message.ref,
        );
    }
  };
  const acquire = storage.exclusive(
    Effect.gen(function* () {
      const held = yield* storage.get<number>("bf:q-lease");
      const now = yield* Effect.sync(() => Date.now());
      if (held !== undefined && held > now) return false;
      yield* storage.put({ "bf:q-lease": now + OUTBOX_LEASE_MS });
      return true;
    }),
  );
  /** Send every staged message; `true` when the outbox is empty. */
  const flush: Effect.Effect<boolean> = Effect.gen(function* () {
    // Nothing staged: no lease to take.
    if ((yield* storage.list({ prefix: "bf:q:", limit: 1 })).length === 0) return true;
    // Another flush holds the lease; it may stop before this one's rows: try again later.
    if (!(yield* acquire)) return yield* Effect.as(jobs.schedule("bf-flush", RETRY_MS), false);
    return yield* Effect.gen(function* () {
      while (true) {
        const rows = yield* storage.list<Message>({ prefix: "bf:q:", limit: 50 });
        if (rows.length === 0) {
          yield* retry.clear("bf-flush");
          return true;
        }
        for (const [key, message] of rows) {
          yield* send(message);
          yield* storage.delete([key]);
        }
      }
    }).pipe(
      // A send failed: the rest stay staged, and the backstop sends them later.
      Effect.catchCause(() => Effect.as(retry.later("bf-flush", RETRY_MS), false)),
      Effect.ensuring(storage.delete(["bf:q-lease"])),
    );
  });
  return {
    /** Stage messages; call inside the exclusive section that commits their cause. */
    stage: (messages: ReadonlyArray<Message>) =>
      Effect.gen(function* () {
        if (messages.length === 0) return;
        const last = ((yield* storage.get<number>("bf:q-seq")) ?? 0) + messages.length;
        const rows: Record<string, Message> = { "bf:q-seq": last as never };
        messages.forEach((message, index) => {
          rows[`bf:q:${pad(last - messages.length + index + 1, 12)}`] = message;
        });
        yield* storage.put(rows);
        // The backstop: sent even if this instance dies before a flush runs.
        yield* jobs.schedule("bf-flush", 5_000);
      }),
    flush,
  };
};

// ---------------------------------------------------------------- sources

/** A source's progress through one target's backfill. */
interface SourceState {
  /** Every row up to this seq has been routed: by the scan, or by a commit after it. */
  readonly scanned: number;
  /** Discovery is complete everywhere. */
  readonly ready: boolean;
  /** Keys still pulling (not yet switched to live delivery). */
  readonly pending: number;
  /** The directory nodes to tell when every key has gone live: each one that readied it. */
  readonly reportTo?: ReadonlyArray<string>;
}

/** What a source instance gives the protocol. */
export interface SourceHost {
  readonly ref: SourceRef;
  /** The consumers this instance's code routes to (`CatchUp.targetId`). */
  readonly targets: () => ReadonlyArray<string>;
  /** Every consumer in the model this instance's code runs: a target outside it is from newer code. */
  readonly model: () => ReadonlyArray<string>;
  /** Its current version: the seq of its last event or entry. */
  readonly version: Effect.Effect<number>;
  readonly routed: Effect.Effect<Routed | undefined>;
  /** Route `target` live from the current version on. Called holding the exclusive section. */
  readonly markLive: (target: string) => Effect.Effect<void>;
  /** Stored rows after `after`, routed to `target` only: each row's seq and its deliveries. */
  readonly rows: (
    after: number,
    limit: number,
    target: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  >;
  /** The deliveries to `target` of the rows at these seqs. */
  readonly rowsAt: (
    seqs: ReadonlyArray<number>,
    target: string,
  ) => Effect.Effect<ReadonlyArray<Delivery>>;
  /** Its stored rows after `after`, as stored: what a key keyed by this instance reads. */
  readonly log: (after: number, limit: number) => Effect.Effect<ReadonlyArray<unknown>>;
}

/** What a source answers to `ready`. */
export type ReadyResult = "stale" | "pending" | "settled";

/**
 * A source instance's part of the protocol. Its host routes every commit's
 * deliveries to a backfilling target through {@link Source.onCommit} (inside
 * the commit's exclusive section) and serves `scan`, `ready` and `pull`.
 */
export const makeSource = (
  storage: Storage,
  jobs: Jobs,
  net: Network,
  host: SourceHost,
  limits: Limits = defaultLimits,
) => {
  const retry = makeRetry(storage, jobs, limits);
  const queue = outbox(storage, jobs, net, limits.depth, retry);
  const stateKey = (target: string) => `bf:s:${enc(target)}`;
  const keyKey = (target: string, key: string) => `bf:k:${enc(target)}:${enc(key)}`;
  const keysPrefix = (target: string) => `bf:k:${enc(target)}:`;
  const indexPrefix = (target: string, key: string) => `bf:r:${enc(target)}:${enc(key)}:`;
  const getState = (target: string) => storage.get<SourceState>(stateKey(target));
  const indexRow = (target: string, delivery: Delivery) => ({
    [`${indexPrefix(target, delivery.key)}${pad(delivery.seq, 12)}`]: true,
  });

  /** Backfilling here: its cursor is behind. An instance with no cursors predates catch-up. */
  const lagging = (target: string, routed: Routed | undefined, version: number) =>
    routed !== undefined && (routed[target] ?? 0) < version;

  const clear = (prefix: string) =>
    Effect.gen(function* () {
      while (true) {
        const rows = yield* storage.list({ prefix, limit: 128 });
        if (rows.length === 0) return;
        yield* storage.delete(rows.map(([key]) => key));
      }
    });

  /** Every key is live: the target is live here. Callers hold the exclusive section. */
  /**
   * Tell this instance's pending keys of `target` to start pulling, and settle once
   * they're all live. `reportTo` is the leaf asking, if a leaf asked.
   */
  const markReady = (target: string, reportTo: string | undefined) =>
    storage.exclusive(
      Effect.gen(function* () {
        const state = yield* getState(target);
        if (state === undefined) return "settled" as const;
        const messages: Array<Message> = [];
        if (!state.ready) {
          let after: string | undefined;
          while (true) {
            const rows = yield* storage.list<"pending" | "live">({
              prefix: keysPrefix(target),
              ...(after === undefined ? {} : { startAfter: after }),
              limit: 128,
            });
            if (rows.length === 0) break;
            for (const [row, status] of rows) {
              if (status !== "pending") continue;
              const key = decodeURIComponent(row.slice(keysPrefix(target).length));
              messages.push({ kind: "ready", target, key });
            }
            after = rows[rows.length - 1]![0];
          }
        }
        if (state.pending === 0) {
          yield* settle(target, messages);
          yield* queue.stage(messages);
          return "settled" as const;
        }
        const to = state.reportTo ?? [];
        yield* storage.put({
          [stateKey(target)]: {
            ...state,
            ready: true,
            reportTo: reportTo === undefined || to.includes(reportTo) ? to : [...to, reportTo],
          },
        });
        yield* queue.stage(messages);
        return "pending" as const;
      }),
    );

  const settle = (target: string, messages: Array<Message>) =>
    Effect.gen(function* () {
      const state = yield* getState(target);
      yield* clear(keysPrefix(target));
      yield* clear(`bf:r:${enc(target)}:`);
      yield* storage.delete([stateKey(target)]);
      yield* host.markLive(target);
      const to = state?.reportTo ?? [];
      if (to.length === 0) messages.push({ kind: "settled", target, ref: host.ref });
      for (const path of to) messages.push({ kind: "settled", target, ref: host.ref, to: path });
    });

  /** Route deliveries to a scanned target by key: send to live keys, index for pulling ones. */
  const route = (target: string, deliveries: ReadonlyArray<Delivery>, discovering: boolean) =>
    Effect.gen(function* () {
      const send: Array<Delivery> = [];
      const messages: Array<Message> = [];
      let added = 0;
      for (const delivery of deliveries) {
        const status = yield* storage.get<"pending" | "live">(keyKey(target, delivery.key));
        if (status === "live") send.push(delivery);
        else if (status === "pending") yield* storage.put(indexRow(target, delivery));
        else if (discovering) {
          // Found in history: the key pulls it, once it knows every source it has.
          yield* storage.put({
            [keyKey(target, delivery.key)]: "pending",
            ...indexRow(target, delivery),
          });
          messages.push({
            kind: "source",
            target,
            key: delivery.key,
            stream: delivery.source,
            ref: host.ref,
          });
          added += 1;
        } else {
          // A key this instance never fed: it has no history here, so it is live from now.
          yield* storage.put({ [keyKey(target, delivery.key)]: "live" });
          send.push(delivery);
        }
      }
      return { send, messages, added };
    });

  return {
    /**
     * A commit's deliveries to `target`, which live routing withheld because
     * the target is backfilling here. Returns those to send now. Call inside
     * the commit's exclusive section, with the versions before and after it.
     */
    onCommit: (
      target: string,
      deliveries: ReadonlyArray<Delivery>,
      before: number,
      after: number,
    ) =>
      Effect.gen(function* () {
        const state = yield* getState(target);
        // The scan hasn't reached the rows before this commit: it will reach these too.
        if (state === undefined || state.scanned < before) return [] as ReadonlyArray<Delivery>;
        const { send, messages, added } = yield* route(target, deliveries, false);
        yield* storage.put({
          [stateKey(target)]: { ...state, scanned: after, pending: state.pending + added },
        });
        yield* queue.stage(messages);
        return send as ReadonlyArray<Delivery>;
      }),

    scan: (target: string) =>
      Effect.gen(function* () {
        if (!host.model().includes(target)) return "stale" as ScanResult;
        // In the model, but not fed by this instance: nothing to discover here.
        if (!host.targets().includes(target)) return "discovered" as ScanResult;
        const result = yield* storage.exclusive(
          Effect.gen(function* () {
            const version = yield* host.version;
            const state = yield* getState(target);
            if (state === undefined && !lagging(target, yield* host.routed, version))
              return "discovered" as const;
            const current: SourceState = state ?? { scanned: 0, ready: false, pending: 0 };
            if (current.scanned >= version) return "discovered" as const;
            const rows = yield* host.rows(current.scanned, limits.page, target);
            const { messages, added } = yield* route(
              target,
              rows.flatMap((row) => row.deliveries),
              true,
            );
            const scanned = rows.length > 0 ? rows[rows.length - 1]!.seq : version;
            yield* storage.put({
              [stateKey(target)]: { ...current, scanned, pending: current.pending + added },
            });
            yield* queue.stage(messages);
            return scanned >= version ? ("discovered" as const) : ("more" as const);
          }),
        );
        yield* trace("scan", { source: host.ref, target, result });
        if (result !== "discovered") return result as ScanResult;
        // Discovered only once every key it feeds has been told: a key's sources are
        // complete when discovery is complete everywhere.
        // Not all could be told yet (one is still on older code, say): back off and ask again.
        if (!(yield* queue.flush)) return "stale" as ScanResult;
        return "discovered" as ScanResult;
      }),

    ready: (target: string, reportTo: string) =>
      Effect.gen(function* () {
        if (!host.model().includes(target)) return "stale" as ReadyResult;
        if (!host.targets().includes(target)) return "settled" as ReadyResult;
        const result = yield* markReady(target, reportTo);
        yield* queue.flush;
        yield* trace("ready", { source: host.ref, target, result });
        return result as ReadyResult;
      }),

    pull: (target: string, key: string, after: number) =>
      Effect.gen(function* () {
        // On older code it knows nothing of the target: refuse, rather than answer "nothing more".
        if (!host.model().includes(target))
          return yield* Effect.die(
            new Stale(`${host.ref.source}/${host.ref.id} does not know ${target} yet`),
          );
        const result: Pulled = yield* storage.exclusive(
          Effect.gen(function* () {
            const state = yield* getState(target);
            const status = yield* storage.get<"pending" | "live">(keyKey(target, key));
            // Settled, or already live: everything was handed over.
            if (state === undefined || status !== "pending") return { deliveries: [], live: true };
            const prefix = indexPrefix(target, key);
            const rows = yield* storage.list({
              prefix,
              startAfter: `${prefix}${pad(after, 12)}`,
              limit: limits.page,
            });
            const seqs = rows.map(([row]) => Number(row.slice(prefix.length)));
            const deliveries = (yield* host.rowsAt(seqs, target)).filter((d) => d.key === key);
            if (rows.length > 0) return { deliveries, live: false, end: rows.length < limits.page };
            // Nothing after the key's cursor, so it holds everything: live from now,
            // atomically with this answer. A lost answer is safe to ask again: a live
            // key's pull answers live, and the key had everything up to its cursor.
            yield* storage.put({ [keyKey(target, key)]: "live" });
            const pending = state.pending - 1;
            const messages: Array<Message> = [];
            if (pending === 0 && state.ready) yield* settle(target, messages);
            else yield* storage.put({ [stateKey(target)]: { ...state, pending } });
            yield* queue.stage(messages);
            return { deliveries: [], live: true };
          }),
        );
        yield* trace("pull", {
          source: host.ref,
          target,
          key,
          after,
          rows: result.deliveries.length,
          live: result.live,
        });
        if (result.live) yield* queue.flush;
        return result;
      }),

    log: (after: number, limit: number) => host.log(after, limit),

    handoff: (target: string, key: string, through: number) =>
      Effect.gen(function* () {
        if (!host.model().includes(target)) return "stale" as Handoff;
        const result = yield* storage.exclusive(
          Effect.gen(function* () {
            // Rows were added after the key read up to `through`: it reads them first.
            if ((yield* host.version) > through) return "more" as const;
            const routed = yield* host.routed;
            if (routed !== undefined && (routed[target] ?? 0) < through)
              yield* host.markLive(target);
            return "live" as const;
          }),
        );
        yield* trace("handoff", { source: host.ref, target, key, through, result });
        return result as Handoff;
      }),

    /** The backstop job: send what is staged. */
    flush: Effect.asVoid(queue.flush),
  };
};

export type Source = ReturnType<typeof makeSource>;

// ---------------------------------------------------------------- consumer keys

/** A consumer key's view of one of its sources during a backfill. */
interface Feed {
  readonly ref: SourceRef | null;
  /** The last seq pulled. */
  readonly cursor: number;
  /** Switched to live delivery: nothing more to pull. */
  readonly live: boolean;
  /** Deliveries from it waiting in the buffer. */
  readonly buffered: number;
}

/** What a consumer key gives the protocol. */
export interface ConsumerHost {
  readonly key: string;
  /** This consumer's target id in the code this instance runs. */
  readonly target: () => string;
  /**
   * Whether each key hears only from the source instance with its own id: then
   * it reads that instance's log itself, as soon as its leaf starts it (no
   * barrier), and applies what it reads directly (nothing to merge).
   */
  readonly singleSource?: () => boolean;
  /**
   * Route a source's stored rows (from its `log`) to this consumer: each row's
   * seq and its deliveries. Runs this key's code, whatever code the source runs.
   */
  readonly history?: (
    ref: SourceRef,
    rows: ReadonlyArray<unknown>,
  ) => ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>;
  /** The sources this consumer reads (`Account`, `Deposits`): where it asks about discovery. */
  readonly sources?: () => ReadonlyArray<string>;
  /**
   * Apply deliveries in order, as the live path would. Called holding the
   * exclusive section.
   */
  readonly apply: (deliveries: ReadonlyArray<Delivery>) => Effect.Effect<void>;
  /** Work an `apply` left for after its exclusive section commits (pushes, sends). */
  readonly after?: Effect.Effect<void>;
}

/**
 * A consumer key's part of the protocol. Its host passes every delivery for
 * the current target through {@link Consumer.admit} before applying it, and
 * serves `source` and `ready`.
 */
export const makeConsumer = (
  storage: Storage,
  jobs: Jobs,
  net: Network,
  host: ConsumerHost,
  limits: Limits = defaultLimits,
) => {
  const T = (target: string) => enc(target);
  const backfillKey = (target: string) => `bf:c:${T(target)}`;
  const doneKey = (target: string) => `bf:done:${T(target)}`;
  const feedKey = (target: string, stream: string) => `bf:f:${T(target)}:${enc(stream)}`;
  const feedsPrefix = (target: string) => `bf:f:${T(target)}:`;
  /** Feeds still pulling with nothing buffered: the merge can't apply past them. */
  const starvedKey = (target: string, stream: string) => `bf:x:${T(target)}:${enc(stream)}`;
  const starvedPrefix = (target: string) => `bf:x:${T(target)}:`;
  const pullingKey = (target: string, stream: string) => `bf:p:${T(target)}:${enc(stream)}`;
  const pullingPrefix = (target: string) => `bf:p:${T(target)}:`;
  const bufferPrefix = (target: string) => `bf:b:${T(target)}:`;
  const jobId = (target: string) => `bf-merge:${target}`;
  /** The source to tell its leaf about once this key has its history (keyed by its source). */
  const reportKey = (target: string) => `bf:report:${T(target)}`;
  const caughtKey = (target: string) => `bf:caught:${T(target)}`;
  const retry = makeRetry(storage, jobs, limits);
  /**
   * A message for another generation of this consumer. A newer one means this
   * instance still runs older code: refuse it, so the sender tries again once
   * it runs the deployed code. An older one is from a superseded backfill.
   */
  const stale = (target: string) =>
    generationOf(target) > generationOf(host.target())
      ? Effect.die(new Stale(`${host.key} runs ${host.target()}, not ${target} yet`))
      : Effect.void;

  interface Backfill {
    readonly ready: boolean;
    /** The directory node to ask whether discovery is complete. */
    readonly ask: string;
  }

  /** Start asking at a node two levels down, picked by the key: the asks spread out. */
  /**
   * A node to ask whether discovery is complete: one of its source's leaves, by
   * the key's hash, so asks spread out. It climbs toward the root past nodes that
   * don't know (without sources, it asks the root).
   */
  const firstAsk = (target: string) => {
    const source = host.sources?.()[0];
    return source === undefined
      ? ""
      : leafOf({ source, id: `${target}/${host.key}` }, Math.min(2, limits.depth));
  };

  const begin = (target: string) =>
    Effect.gen(function* () {
      const existing = yield* storage.get<Backfill>(backfillKey(target));
      if (existing) return existing;
      const backfill: Backfill = { ready: false, ask: firstAsk(target) };
      yield* storage.put({ [backfillKey(target)]: backfill });
      yield* jobs.schedule(jobId(target), 0);
      return backfill;
    });

  /** Record a feed's buffered count and whether it starves the merge. */
  const starves = (feed: Feed | undefined) =>
    feed !== undefined && !feed.live && feed.buffered === 0;
  const putFeed = (target: string, stream: string, feed: Feed) =>
    Effect.gen(function* () {
      const before = yield* storage.get<Feed>(feedKey(target, stream));
      yield* storage.put({ [feedKey(target, stream)]: feed });
      // The indexes change only when the feed's state does: one write per row otherwise.
      if (before === undefined || before.live !== feed.live) {
        if (!feed.live) yield* storage.put({ [pullingKey(target, stream)]: true });
        else yield* storage.delete([pullingKey(target, stream)]);
      }
      if (before === undefined || starves(before) !== starves(feed)) {
        if (starves(feed)) yield* storage.put({ [starvedKey(target, stream)]: true });
        else yield* storage.delete([starvedKey(target, stream)]);
      }
    });

  /** Buffer deliveries in merge order. Callers hold the exclusive section. */
  const buffer = (target: string, deliveries: ReadonlyArray<Delivery>, live: boolean) =>
    Effect.gen(function* () {
      // Each feed is written once per call, however many of its deliveries arrive.
      const feeds = new Map<string, Feed>();
      for (const delivery of deliveries) {
        const key = orderKey(target, delivery);
        if ((yield* storage.get(key)) !== undefined) continue;
        yield* storage.put({ [key]: delivery });
        const feed = feeds.get(delivery.source) ??
          (yield* storage.get<Feed>(feedKey(target, delivery.source))) ?? {
            ref: null,
            cursor: 0,
            // Arriving live from a source it never heard of: one with no history for this key.
            live,
            buffered: 0,
          };
        feeds.set(delivery.source, { ...feed, buffered: feed.buffered + 1 });
      }
      for (const [stream, feed] of feeds) yield* putFeed(target, stream, feed);
    });

  /** Ask the directory whether discovery is complete; climb toward the root past nodes that don't know. */
  const askPhase = (target: string, backfill: Backfill) =>
    Effect.gen(function* () {
      const phase = yield* net.node.phase(backfill.ask, target);
      return {
        phase,
        ask: phase === "unknown" && backfill.ask !== "" ? parentOf(backfill.ask) : backfill.ask,
      };
    });

  /**
   * Read a page of the source's log and route it with this key's code. At the
   * end of the log, ask the source to deliver live from there: `caughtUp` either
   * way, since the key has every row the source had.
   */
  const readLog = (target: string, ref: SourceRef, cursor: number) =>
    Effect.gen(function* () {
      const rows = yield* net.source.log(ref, cursor, limits.page);
      const routed = host.history!(ref, rows);
      const through = routed.length > 0 ? routed[routed.length - 1]!.seq : cursor;
      const deliveries = routed
        .flatMap((row) => row.deliveries)
        .filter((delivery) => delivery.key === host.key);
      if (rows.length >= limits.page)
        return { deliveries, live: false, through, caughtUp: false } satisfies Pulled & {
          readonly caughtUp: boolean;
        };
      const handoff = yield* net.source
        .handoff(ref, target, host.key, through)
        .pipe(Effect.catchCause(() => Effect.succeed("stale" as Handoff)));
      return {
        deliveries,
        live: handoff === "live",
        through,
        // Rows were added meanwhile: read them at once.
        end: handoff === "more",
        caughtUp: handoff !== "more",
      } satisfies Pulled & { readonly caughtUp: boolean };
    });

  /** Tell the leaf that this key has its history, once. */
  const report = (target: string) =>
    Effect.gen(function* () {
      const ref = yield* storage.get<SourceRef>(reportKey(target));
      if (ref === undefined) return;
      yield* net.node.settled(leafOf(ref, limits.depth), target, ref);
      yield* storage.delete([reportKey(target)]);
      yield* trace("caught-up", { key: host.key, target });
    });

  /** Pull a page for each feed that starves the merge. */
  const pullStarved = (target: string) =>
    Effect.gen(function* () {
      const starved = yield* storage.list({
        prefix: starvedPrefix(target),
        limit: limits.concurrency * 4,
      });
      const streams = starved.map(([row]) =>
        decodeURIComponent(row.slice(starvedPrefix(target).length)),
      );
      // A page that reached the end of its source is followed at once by the pull
      // that switches the feed to live, so the merge never stops to wait for it.
      const pullFeed = (stream: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const feed = yield* storage.get<Feed>(feedKey(target, stream));
          if (!feed || feed.live || feed.ref === null) return false;
          // Keyed by its source: the key reads the source's log and routes it itself.
          const pulled = yield* (
            host.singleSource?.() === true && host.history !== undefined
              ? readLog(target, feed.ref, feed.cursor)
              : net.source.pull(feed.ref, target, host.key, feed.cursor)
          ).pipe(
            // Refused (still on older code) or lost in transit: pull it again later.
            Effect.catchCause(() => Effect.succeed(undefined)),
          );
          if (pulled === undefined) return true;
          yield* storage.exclusive(
            Effect.gen(function* () {
              const current = yield* storage.get<Feed>(feedKey(target, stream));
              if (!current || current.cursor !== feed.cursor) return;
              // Read up to the end of its source's log: its history is here, whether
              // or not the source could switch it to live delivery yet.
              if (
                "caughtUp" in pulled &&
                pulled.caughtUp &&
                !(yield* storage.get(caughtKey(target)))
              )
                yield* storage.put({ [caughtKey(target)]: true, [reportKey(target)]: feed.ref });
              // Its only source, and nothing buffered ahead: the page is already in
              // order, so apply it rather than buffer it.
              const direct =
                host.singleSource?.() === true &&
                (yield* storage.list({ prefix: bufferPrefix(target), limit: 1 })).length === 0;
              if (direct) {
                for (const delivery of pulled.deliveries) yield* host.apply([delivery]);
              } else yield* buffer(target, pulled.deliveries, false);
              const after = (yield* storage.get<Feed>(feedKey(target, stream)))!;
              yield* putFeed(target, stream, {
                ...after,
                cursor: Math.max(
                  after.cursor,
                  pulled.through ?? 0,
                  ...pulled.deliveries.map((d) => d.seq),
                ),
                live: pulled.live,
              });
            }),
          );
          if (pulled.end === true && !pulled.live) return yield* pullFeed(stream);
          // A source on code without the target can't deliver live yet: read again later.
          return "caughtUp" in pulled && pulled.caughtUp === true && !pulled.live;
        });
      const failed = yield* Effect.forEach(streams, pullFeed, {
        concurrency: limits.concurrency,
      });
      return failed.some((stale) => stale);
    });

  /**
   * Apply buffered deliveries in merge order while no pulling feed starves the
   * merge. Once ready, with no feed left to pull and nothing buffered, the
   * backfill is done and the key goes back to applying directly.
   */
  const applyBuffered = (target: string) =>
    storage.exclusive(
      Effect.gen(function* () {
        const backfill = yield* storage.get<Backfill>(backfillKey(target));
        if (!backfill) return "done" as const;
        if ((yield* storage.list({ prefix: starvedPrefix(target), limit: 1 })).length > 0)
          return "starved" as const;
        // A page in merge order, each delivery applied on its own (as live, so watchers and
        // downstream consumers see every change), each feed written once. It stops after
        // the delivery that leaves a feed still pulling with nothing buffered.
        const page = yield* storage.list<Delivery>({
          prefix: bufferPrefix(target),
          limit: limits.apply,
        });
        const feeds = new Map<string, Feed>();
        const applied: Array<Delivery> = [];
        let starved = false;
        for (const [, delivery] of page) {
          const feed =
            feeds.get(delivery.source) ??
            (yield* storage.get<Feed>(feedKey(target, delivery.source)))!;
          const next = { ...feed, buffered: feed.buffered - 1 };
          feeds.set(delivery.source, next);
          yield* host.apply([delivery]);
          applied.push(delivery);
          if (starves(next)) {
            starved = true;
            break;
          }
        }
        if (applied.length > 0) {
          yield* storage.delete(page.slice(0, applied.length).map(([row]) => row));
          for (const [stream, feed] of feeds) yield* putFeed(target, stream, feed);
        }
        if (starved) return "starved" as const;
        if (page.length >= limits.apply) return "more" as const;
        if (!backfill.ready) return "waiting" as const;
        if ((yield* storage.list({ prefix: pullingPrefix(target), limit: 1 })).length > 0)
          return "starved" as const;
        // Ready, every feed live and the buffer empty: done, atomically with the last apply.
        for (const prefix of [feedsPrefix(target), starvedPrefix(target), pullingPrefix(target)]) {
          while (true) {
            const rows = yield* storage.list({ prefix, limit: 128 });
            if (rows.length === 0) break;
            yield* storage.delete(rows.map(([key]) => key));
          }
        }
        yield* storage.delete([backfillKey(target), `bf:asked:${T(target)}`, caughtKey(target)]);
        yield* storage.put({ [doneKey(target)]: true });
        return "done" as const;
      }),
    );

  return {
    /**
     * Deliveries for `target` arriving at this key. `true`: apply them now, as
     * usual. `false`: the key is backfilling, and they were buffered.
     */
    admit: (target: string, deliveries: ReadonlyArray<Delivery>) =>
      Effect.gen(function* () {
        const known = yield* storage.exclusive(
          Effect.gen(function* () {
            if (yield* storage.get(doneKey(target))) return "apply" as const;
            if (!(yield* storage.get(backfillKey(target)))) return "unknown" as const;
            yield* buffer(target, deliveries, true);
            yield* jobs.schedule(jobId(target), 0);
            return "buffered" as const;
          }),
        );
        if (known !== "unknown") return known === "apply";
        // A key's first delivery for this target: is a backfill still running?
        const { phase } = yield* askPhase(target, { ready: false, ask: firstAsk(target) });
        return yield* storage.exclusive(
          Effect.gen(function* () {
            if (yield* storage.get(doneKey(target))) return true;
            if (phase === "complete" && !(yield* storage.get(backfillKey(target)))) {
              yield* storage.put({ [doneKey(target)]: true });
              return true;
            }
            yield* begin(target);
            yield* buffer(target, deliveries, true);
            yield* jobs.schedule(jobId(target), 0);
            return false;
          }),
        );
      }),

    source: (target: string, stream: string, ref: SourceRef) =>
      storage.exclusive(
        Effect.gen(function* () {
          yield* trace("told-source", { key: host.key, target, stream });
          if (target !== host.target()) return yield* stale(target);
          // A source that joined after this key finished (an instance listed late):
          // take up the backfill again for it, rather than lose its history.
          const reopened = (yield* storage.get(doneKey(target))) !== undefined;
          if (reopened) {
            const feed = yield* storage.get<Feed>(feedKey(target, stream));
            if (feed) return;
            yield* storage.delete([doneKey(target)]);
            yield* storage.put({ [backfillKey(target)]: { ready: true, ask: firstAsk(target) } });
            yield* jobs.schedule(jobId(target), 0);
          }
          yield* begin(target);
          const feed = yield* storage.get<Feed>(feedKey(target, stream));
          if (feed && feed.ref !== null) return;
          // A feed first seen live (buffered) now turns out to have history: pull it.
          yield* putFeed(target, stream, {
            ref,
            cursor: 0,
            live: false,
            buffered: feed?.buffered ?? 0,
          });
        }),
      ),

    start: (target: string, ref: SourceRef) =>
      storage.exclusive(
        Effect.gen(function* () {
          yield* trace("start", { key: host.key, target });
          if (target !== host.target()) {
            yield* stale(target);
            // An older generation's sweep: superseded, nothing to wait for.
            return "settled" as const;
          }
          if (yield* storage.get(doneKey(target))) return "settled" as const;
          if ((yield* storage.get(caughtKey(target))) !== undefined) {
            // Caught up already; its report may still be on its way.
            if ((yield* storage.get(reportKey(target))) === undefined) return "settled" as const;
          }
          const backfill = yield* begin(target);
          if (!backfill.ready)
            yield* storage.put({ [backfillKey(target)]: { ...backfill, ready: true } });
          const stream = `${ref.source}/${ref.id}`;
          const feed = yield* storage.get<Feed>(feedKey(target, stream));
          if (feed === undefined || feed.ref === null)
            yield* putFeed(target, stream, {
              ref,
              cursor: 0,
              live: false,
              buffered: feed?.buffered ?? 0,
            });
          yield* jobs.schedule(jobId(target), 0);
          return "pending" as const;
        }),
      ),

    ready: (target: string) =>
      storage.exclusive(
        Effect.gen(function* () {
          yield* trace("told-ready", { key: host.key, target });
          if (target !== host.target()) return yield* stale(target);
          if (yield* storage.get(doneKey(target))) return;
          const backfill = yield* begin(target);
          if (!backfill.ready)
            yield* storage.put({ [backfillKey(target)]: { ...backfill, ready: true } });
          yield* jobs.schedule(jobId(target), 0);
        }),
      ),

    /** The merge job for one target. */
    merge: (target: string) =>
      Effect.gen(function* () {
        // Has its history: tell its leaf (again, after a failed attempt), even once done.
        const reported = yield* report(target).pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        );
        if (!reported) return yield* retry.later(jobId(target), RETRY_MS);
        const backfill = yield* storage.get<Backfill>(backfillKey(target));
        if (!backfill) return;
        if (!backfill.ready) {
          // A key with sources is told when discovery is complete; ask the directory only
          // rarely, as a safety net. One fed only live has no source to tell it: it asks.
          const pulling =
            (yield* storage.list({ prefix: pullingPrefix(target), limit: 1 })).length > 0;
          yield* trace("waiting", { key: host.key, target, pulling });
          if (pulling && !(yield* storage.get(`bf:asked:${T(target)}`))) {
            yield* storage.put({ [`bf:asked:${T(target)}`]: true });
            return yield* jobs.schedule(jobId(target), SAFETY_POLL_MS);
          }
          const asked = yield* askPhase(target, backfill).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
          );
          if (asked === undefined) return yield* retry.later(jobId(target), RETRY_MS);
          const { phase, ask } = asked;
          const ready = phase === "ready" || phase === "complete";
          yield* storage.exclusive(
            Effect.gen(function* () {
              const current = yield* storage.get<Backfill>(backfillKey(target));
              if (current)
                yield* storage.put({
                  [backfillKey(target)]: { ...current, ready: current.ready || ready, ask },
                });
            }),
          );
          // Its sources tell a key with history when it's ready: it asks again only
          // rarely, so a wide backfill never polls the directory hard.
          if (!ready)
            return yield* jobs.schedule(
              jobId(target),
              ask !== backfill.ask ? 0 : pulling ? SAFETY_POLL_MS : limits.pollMillis,
            );
        }
        const outcome = yield* applyBuffered(target);
        yield* trace("merge", { key: host.key, target, outcome });
        if (host.after) yield* host.after;
        if (outcome === "done" || outcome === "waiting") {
          // The key's history is complete: it tells its leaf on the next run.
          if ((yield* storage.get(reportKey(target))) !== undefined)
            return yield* jobs.schedule(jobId(target), 0);
          return yield* retry.clear(jobId(target));
        }
        // A remote failure never fails the job (which a durable callback would retry
        // with a growing delay, then park): it asks again after a fixed wait.
        const failed = outcome === "starved" ? yield* pullStarved(target) : false;
        if ((yield* storage.get(reportKey(target))) !== undefined)
          yield* report(target).pipe(Effect.catchCause(() => Effect.void));
        if (failed) return yield* retry.later(jobId(target), RETRY_MS);
        yield* retry.clear(jobId(target));
        yield* jobs.schedule(jobId(target), 0);
      }),

    /** Is a backfill of `target` still running on this key? */
    backfilling: (target: string) =>
      Effect.map(storage.get(backfillKey(target)), (backfill) => backfill !== undefined),
  };
};

export type Consumer = ReturnType<typeof makeConsumer>;

// ---------------------------------------------------------------- directory

/** A node's progress through one phase of a target's sweep. */
interface Sweep {
  readonly phase: "discover" | "ready" | "complete";
  /** The children told of this phase. */
  readonly children: ReadonlyArray<string>;
  readonly told: boolean;
  /** Own instances: the last one listed, whether all are, and those to call again. */
  readonly cursor: string | null;
  readonly listed: boolean;
  readonly pending: ReadonlyArray<SourceRef>;
  /** Own instances are done with this phase. */
  readonly own: boolean;
  readonly reported: boolean;
  /**
   * Told of a later phase without having taken part in discovery (it linked
   * after it): its own instances are caught up as late joiners, listed from
   * here. `undefined` once all are listed.
   */
  readonly adopting?: string | null;
}

const PHASES = ["discover", "ready", "complete"] as const;

/**
 * A directory node: lists instances, links itself into its parent, and runs
 * its part of each target's sweep.
 */
export const makeNode = (
  storage: Storage,
  jobs: Jobs,
  net: Network,
  limits: Limits = defaultLimits,
  /**
   * A consumer's plan in the code this node runs, for one the announcement
   * didn't carry a plan for. `undefined` for a consumer it doesn't know (older
   * code): it sweeps every subtree and calls every source.
   */
  planOf: (target: string) => Plan | undefined = () => undefined,
) => {
  const sweepKey = (target: string) => `sw:${enc(target)}`;
  const planKey = (target: string) => `plan:${enc(target)}`;
  /** The plan the announcement carried, else this code's. */
  const planFor = (target: string) =>
    Effect.map(storage.get<Plan>(planKey(target)), (stored) => stored ?? planOf(target));
  const keepPlan = (target: string, plan: Plan | undefined) =>
    Effect.gen(function* () {
      if (plan !== undefined && (yield* storage.get(planKey(target))) === undefined)
        yield* storage.put({ [planKey(target)]: plan });
    });
  const retry = makeRetry(storage, jobs, limits);
  const getSweep = (target: string) => storage.get<Sweep>(sweepKey(target));
  const reportPrefix = (target: string, phase: string) => `rp:${enc(target)}:${phase}:`;
  const unsettledPrefix = (target: string) => `us:${enc(target)}:`;
  const settledKey = (target: string, ref: SourceRef) => `st:${enc(target)}:${refKey(ref)}`;
  /** This node's part of a phase so far: when it began and handled its own instances. */
  const hopKey = (target: string, phase: string) => `tl:${enc(target)}:${phase}`;
  const lastSettledKey = (target: string) => `tl:${enc(target)}:settled`;

  /** Remember this node's path (jobs read it), written once. */
  const keepPath = (path: string) =>
    Effect.gen(function* () {
      if ((yield* storage.get<string>("path")) !== path) yield* storage.put({ path });
    });

  /**
   * Link this node into its parent, and so on up to the root, before answering:
   * an instance's first commit waits for it, so every instance with an event
   * can be reached from the root. Only a node's first registration pays for it.
   */
  const ensureLinked = (path: string) =>
    Effect.gen(function* () {
      if (path === "" || (yield* storage.get("linked"))) return;
      // One link at a time: registrations arriving together all find the node
      // unlinked, and would each call its parent, and so on up to a flooded root.
      yield* linking.withPermits(1)(
        Effect.gen(function* () {
          if (yield* storage.get("linked")) return;
          yield* net.node
            .child(parentOf(path), path)
            .pipe(Effect.tapCause((cause) => trace("link-failed", { path, cause: String(cause) })));
          yield* storage.exclusive(storage.put({ linked: true, path }));
          yield* trace("linked", { path });
        }),
      );
    });
  const linking = Semaphore.makeUnsafe(1);

  /** Every sweep this node takes part in. */
  const sweeps = Effect.map(storage.list<Sweep>({ prefix: "sw:" }), (rows) =>
    rows.map(([key, sweep]) => ({ target: decodeURIComponent(key.slice(3)), sweep })),
  );
  const latePrefix = (target: string) => `late:${enc(target)}:`;

  /**
   * An instance listed after this node's discovery for a target moved on: one
   * created while the sweep runs (on code without the target, during a
   * rollout). Catch it up on its own. Callers hold the exclusive section.
   */
  const join = (path: string, ref: SourceRef, key: string) =>
    Effect.gen(function* () {
      for (const { target, sweep } of yield* sweeps) {
        if (sweep.phase === "discover" && !sweep.reported) {
          // The listing reaches it, unless it has passed it already.
          if (!sweep.listed && (sweep.cursor === null || key > sweep.cursor)) continue;
          yield* storage.put({
            [sweepKey(target)]: { ...sweep, pending: [...sweep.pending, ref], own: false },
          });
          yield* jobs.schedule(`step:${target}`, 0);
          continue;
        }
        if (sweep.phase === "ready" && !sweep.reported)
          yield* storage.put({ [`${unsettledPrefix(target)}${refKey(ref)}`]: ref });
        yield* storage.put({ [`${latePrefix(target)}${refKey(ref)}`]: ref });
        yield* jobs.schedule(`late:${target}`, 0);
      }
    });

  /**
   * Move a page of listed instances to the children (each lists itself and links
   * in, joining any running sweep), until none are left here.
   */
  const split = (path: string) =>
    Effect.gen(function* () {
      // Moving instances while a sweep runs could take one past this node's listing
      // and into a child that has finished: wait until no sweep is under way here.
      // Meanwhile new instances already go to the children, so this node stays bounded.
      const running = (yield* sweeps).some(({ sweep }) => sweep.phase !== "complete");
      if (running) return yield* jobs.schedule("split", RETRY_MS);
      const rows = yield* storage.list<SourceRef>({ prefix: "i:", limit: limits.nodePage });
      if (rows.length === 0) return;
      yield* Effect.forEach(rows, ([, ref]) => net.node.register(childFor(path, ref), ref), {
        concurrency: limits.concurrency,
        discard: true,
      });
      yield* storage.exclusive(storage.delete(rows.map(([key]) => key)));
      yield* jobs.schedule("split", 0);
    });

  /** Scan and ready the instances that joined late, a page at a time. */
  const late = (path: string, target: string) =>
    Effect.gen(function* () {
      const sweep = yield* getSweep(target);
      if (sweep?.adopting !== undefined) {
        // List the own instances as late joiners first, a page per step.
        const own = yield* storage.list<SourceRef>({
          prefix: "i:",
          ...(sweep.adopting === null ? {} : { startAfter: sweep.adopting }),
          limit: limits.nodePage,
        });
        yield* storage.exclusive(
          Effect.gen(function* () {
            const current = yield* getSweep(target);
            if (!current || current.adopting !== sweep.adopting) return;
            for (const [, ref] of own) {
              if (current.phase === "ready" && !current.reported)
                yield* storage.put({ [`${unsettledPrefix(target)}${refKey(ref)}`]: ref });
              yield* storage.put({ [`${latePrefix(target)}${refKey(ref)}`]: ref });
            }
            const { adopting: _, ...rest } = current;
            yield* storage.put({
              [sweepKey(target)]:
                own.length < limits.nodePage
                  ? rest
                  : { ...current, adopting: own[own.length - 1]![0] },
            });
          }),
        );
        return yield* jobs.schedule(`late:${target}`, 0);
      }
      // During discovery a late instance is only scanned: telling its keys discovery
      // is complete must wait until it is, everywhere (this node's ready phase). Those
      // rows stay, so a page is listed after the last one scanned, kept in `late-at:`.
      const discovering = (yield* getSweep(target))?.phase === "discover";
      const cursorKey = `late-at:${enc(target)}`;
      const cursor = discovering ? yield* storage.get<string>(cursorKey) : undefined;
      const rows = yield* storage.list<SourceRef>({
        prefix: latePrefix(target),
        ...(cursor === undefined ? {} : { startAfter: cursor }),
        limit: limits.nodePage,
      });
      let stale = false;
      const plan = yield* planFor(target);
      for (const [row, ref] of rows) {
        if (plan?.singleSource === true) {
          // Its key reads its log itself: start it, and wait for it to report.
          const started = yield* net.consumer
            .start(target, ref.id, ref)
            .pipe(Effect.catchCause(() => Effect.succeed("stale" as const)));
          if (started === "stale") {
            stale = true;
            continue;
          }
          yield* storage.exclusive(
            Effect.gen(function* () {
              yield* storage.delete([row]);
              const current = yield* getSweep(target);
              if (started === "settled")
                yield* storage.delete([`${unsettledPrefix(target)}${refKey(ref)}`]);
              else if (
                current?.phase !== "complete" &&
                !current?.reported &&
                !(yield* storage.get(settledKey(target, ref)))
              )
                yield* storage.put({ [`${unsettledPrefix(target)}${refKey(ref)}`]: ref });
              yield* settle(path, target);
            }),
          );
          continue;
        }
        const scanned = yield* net.source
          .scan(ref, target)
          .pipe(Effect.catchCause(() => Effect.succeed("stale" as const)));
        if (scanned === "stale") stale = true;
        if (scanned !== "discovered") continue;
        if (discovering) continue;
        const ready = yield* net.source
          .ready(ref, target, path)
          .pipe(Effect.catchCause(() => Effect.succeed("stale" as const)));
        if (ready === "stale") {
          stale = true;
          continue;
        }
        yield* storage.exclusive(
          Effect.gen(function* () {
            yield* storage.delete([row]);
            if (ready === "settled")
              yield* storage.delete([`${unsettledPrefix(target)}${refKey(ref)}`]);
            yield* settle(path, target);
          }),
        );
      }
      if (discovering) {
        // Scanned up to here; at the end of the list, `begin` runs this job again in the
        // ready phase (a stale instance is scanned again from the start).
        if (stale) yield* storage.delete([cursorKey]);
        else if (rows.length > 0) yield* storage.put({ [cursorKey]: rows[rows.length - 1]![0] });
        if (stale) return yield* retry.later(`late:${target}`, limits.staleRetryMillis);
        yield* retry.clear(`late:${target}`);
        if (rows.length === limits.nodePage) yield* jobs.schedule(`late:${target}`, 0);
        return;
      }
      if (stale) return yield* retry.later(`late:${target}`, limits.staleRetryMillis);
      yield* retry.clear(`late:${target}`);
      if (rows.length > 0) yield* jobs.schedule(`late:${target}`, 0);
    });

  /**
   * A consumer keyed by its source: start the instance's own key, which reads the
   * instance's log itself (whatever code the instance runs), and wait for it to
   * report that it has its history. Starting is idempotent: a key that has its
   * history already (live deliveries alone can complete one) answers `settled`.
   */
  const startKey = (target: string, ref: SourceRef) =>
    Effect.gen(function* () {
      if ((yield* storage.get(settledKey(target, ref))) !== undefined) return "done" as const;
      const started = yield* net.consumer.start(target, ref.id, ref);
      return started === "settled" ? ("done" as const) : ("pending" as const);
    });

  const begin = (path: string, target: string, phase: Sweep["phase"]) =>
    Effect.gen(function* () {
      yield* trace("phase", { path, target, phase });
      const linked = (yield* storage.list({ prefix: "c:" })).map(([key]) => key.slice(2));
      // The root sweeps only the subtrees of the sources the consumer reads.
      const sources = path === "" ? (yield* planFor(target))?.sources : undefined;
      const children =
        sources === undefined
          ? linked
          : linked.filter((child) => sources.includes(sourceOfPath(child) ?? ""));
      const previous = yield* getSweep(target);
      const adopting = phase !== "discover" && previous === undefined ? null : previous?.adopting;
      yield* keepPath(path);
      yield* storage.put({ [hopKey(target, phase)]: { begin: yield* Clock.currentTimeMillis } });
      yield* storage.put({
        [sweepKey(target)]: {
          phase,
          children,
          told: false,
          cursor: null,
          listed: false,
          pending: [],
          own: phase === "complete",
          reported: false,
          ...(adopting === undefined ? {} : { adopting }),
        } satisfies Sweep,
      });
      if (
        adopting !== undefined ||
        (phase !== "discover" &&
          (yield* storage.list({ prefix: latePrefix(target), limit: 1 })).length > 0)
      )
        yield* jobs.schedule(`late:${target}`, 0);
      if (phase === "complete") {
        yield* storage.put({ [`done:${enc(target)}`]: true });
        if (path === "") {
          const complete = (yield* storage.get<Array<string>>("complete")) ?? [];
          if (!complete.includes(target)) yield* storage.put({ complete: [...complete, target] });
        }
      }
      yield* jobs.schedule(`step:${target}`, 0);
    });

  /**
   * Done with this phase here once the own instances and every child are (and,
   * for `ready`, every own instance has settled): report to the parent, or at
   * the root start the next phase. Callers hold the exclusive section.
   */
  const settle = (path: string, target: string) =>
    Effect.gen(function* () {
      const sweep = yield* getSweep(target);
      if (!sweep || sweep.reported || !sweep.own || sweep.phase === "complete") return;
      const reports = yield* storage.list<{ at: number; trail: ReadonlyArray<Hop> } | true>({
        prefix: reportPrefix(target, sweep.phase),
      });
      const reported = new Set(
        reports.map(([key]) => key.slice(reportPrefix(target, sweep.phase).length)),
      );
      if (sweep.children.some((child) => !reported.has(child))) return;
      if (
        sweep.phase === "ready" &&
        (yield* storage.list({ prefix: unsettledPrefix(target), limit: 1 })).length > 0
      )
        return;
      yield* storage.put({ [sweepKey(target)]: { ...sweep, reported: true } });
      yield* trace("settled-phase", { path, target, phase: sweep.phase });
      // The critical path: this node's hop, then the trail of the child it waited for last.
      let last: { child: string; at: number; trail: ReadonlyArray<Hop> } | undefined;
      for (const [key, value] of reports) {
        if (value === true) continue;
        if (last === undefined || value.at > last.at)
          last = { child: key.slice(reportPrefix(target, sweep.phase).length), ...value };
      }
      const begun = yield* storage.get<{ begin: number; own?: number }>(
        hopKey(target, sweep.phase),
      );
      const settledAt =
        sweep.phase === "ready" ? yield* storage.get<number>(lastSettledKey(target)) : undefined;
      const hop: Hop = {
        path,
        begin: begun?.begin ?? 0,
        ...(begun?.own === undefined ? {} : { own: begun.own }),
        ...(settledAt === undefined ? {} : { settled: settledAt }),
        end: yield* Clock.currentTimeMillis,
        ...(last === undefined ? {} : { last: last.child, lastAt: last.at }),
      };
      const trail = [hop, ...(last?.trail ?? [])];
      yield* storage.put({ [hopKey(target, sweep.phase)]: trail });
      if (path === "")
        yield* Effect.logInfo(
          `backfill trail ${JSON.stringify({ target, phase: sweep.phase, trail })}`,
        );
      if (path !== "") return yield* jobs.schedule(`report:${target}`, 0);
      yield* begin(path, target, sweep.phase === "discover" ? "ready" : "complete");
    });

  /** One step of a phase: tell the children, then handle a page of own instances. */
  const step = (path: string, target: string) =>
    Effect.gen(function* () {
      const sweep = yield* getSweep(target);
      if (!sweep) return;
      // Children are told even after this node reported: a child that linked late
      // takes part in the phase (its report is no longer waited for).
      const plan = yield* planFor(target);
      if (!sweep.told) {
        const told = yield* Effect.forEach(
          sweep.children,
          (child) =>
            net.node.sweep(child, target, sweep.phase, plan).pipe(
              Effect.as(true),
              Effect.catchCause(() => Effect.succeed(false)),
            ),
          { concurrency: limits.concurrency },
        );
        yield* trace("told", {
          path,
          target,
          phase: sweep.phase,
          children: sweep.children,
          failed: sweep.children.filter((_, i) => !told[i]),
        });
        // A child that could not be told is told on the next step.
        if (told.includes(false)) return yield* retry.later(`step:${target}`, RETRY_MS);
        // A child that linked while these were told was not among them: tell it on another step.
        const toldAll = yield* storage.exclusive(
          Effect.gen(function* () {
            const current = yield* getSweep(target);
            if (current?.phase !== sweep.phase) return true;
            if (current.children.some((child) => !sweep.children.includes(child))) return false;
            yield* storage.put({ [sweepKey(target)]: { ...current, told: true } });
            return true;
          }),
        );
        if (!toldAll) yield* jobs.schedule(`step:${target}`, 0);
      }
      if (sweep.reported || sweep.own) return;
      // Own instances to call: those waiting, else the next page of the listing. The page
      // moves into `pending` and the cursor past it at once, so an instance that lists
      // itself meanwhile is either ahead of the cursor or joins `pending`, never skipped.
      const batch = yield* storage.exclusive(
        Effect.gen(function* () {
          const current = yield* getSweep(target);
          if (!current || current.phase !== sweep.phase || current.reported) return [];
          if (current.pending.length > 0 || current.listed)
            return current.pending.slice(0, limits.nodePage);
          const page = yield* storage.list<SourceRef>({
            prefix: "i:",
            ...(current.cursor === null ? {} : { startAfter: current.cursor }),
            limit: limits.nodePage,
          });
          yield* storage.put({
            [sweepKey(target)]: {
              ...current,
              cursor: page.length > 0 ? page[page.length - 1]![0] : current.cursor,
              listed: page.length < limits.nodePage,
              pending: page.map(([, ref]) => ref),
            },
          });
          return page.map(([, ref]) => ref);
        }),
      );
      const call = (ref: SourceRef): Effect.Effect<"done" | "more" | "stale" | "pending"> =>
        plan?.singleSource === true
          ? startKey(target, ref)
          : sweep.phase === "discover"
            ? Effect.map(net.source.scan(ref, target), (result) =>
                result === "discovered" ? "done" : result,
              )
            : Effect.map(net.source.ready(ref, target, path), (result) =>
                result === "settled" ? "done" : result,
              );
      const results = yield* Effect.forEach(
        batch,
        (ref) =>
          call(ref).pipe(
            // Lost in transit, or refused: like older code, call it again after a wait.
            Effect.catchCause(() => Effect.succeed("stale" as const)),
            Effect.map((result) => ({ ref, result })),
          ),
        { concurrency: limits.concurrency },
      );
      const stale = results.some(({ result }) => result === "stale");
      yield* trace("step", {
        path,
        target,
        phase: sweep.phase,
        results: results.map(({ ref, result }) => `${ref.source}/${ref.id}:${result}`),
      });
      const next = yield* storage.exclusive(
        Effect.gen(function* () {
          const current = yield* getSweep(target);
          if (!current || current.phase !== sweep.phase || current.reported) return undefined;
          for (const { ref, result } of results) {
            // Waiting on its keys: it reports `settled` when they are all live.
            if (result === "pending" && !(yield* storage.get(settledKey(target, ref))))
              yield* storage.put({ [`${unsettledPrefix(target)}${refKey(ref)}`]: ref });
          }
          // Done with those that answered; those still to call (and any that joined) stay.
          const finished = new Set(
            results
              .filter(({ result }) => result === "done" || result === "pending")
              .map(({ ref }) => refKey(ref)),
          );
          const pending = current.pending.filter((ref) => !finished.has(refKey(ref)));
          const updated: Sweep = {
            ...current,
            pending,
            own: current.listed && pending.length === 0,
          };
          yield* storage.put({ [sweepKey(target)]: updated });
          if (updated.own && !current.own) {
            const hop = yield* storage.get<{ begin: number }>(hopKey(target, current.phase));
            yield* storage.put({
              [hopKey(target, current.phase)]: { ...hop, own: yield* Clock.currentTimeMillis },
            });
          }
          yield* settle(path, target);
          return updated;
        }),
      );
      // Instances still on older code keep it while calls keep them busy: back off.
      if (stale) return yield* retry.later(`step:${target}`, limits.staleRetryMillis);
      yield* retry.clear(`step:${target}`);
      if (next && !next.own) yield* jobs.schedule(`step:${target}`, 0);
    });

  return {
    register: (path: string, ref: SourceRef) =>
      Effect.gen(function* () {
        const forward = yield* storage.exclusive(
          Effect.gen(function* () {
            // Split: its children list instances now.
            if (yield* storage.get("split")) return childFor(path, ref);
            const key = `i:${refKey(ref)}`;
            if ((yield* storage.get(key)) !== undefined) return undefined;
            const count = ((yield* storage.get<number>("count")) ?? 0) + 1;
            yield* keepPath(path);
            yield* storage.put({ [key]: ref, count });
            yield* join(path, ref, key);
            // Full: split into 16 children by the next hex digit, a page at a time.
            if (count > limits.leafSize && digitsOf(path).length < 8) {
              yield* storage.put({ split: true });
              yield* jobs.schedule("split", 0);
            }
            return undefined;
          }),
        );
        yield* ensureLinked(path);
        if (forward !== undefined) yield* net.node.register(forward, ref);
      }),
    child: (path: string, child: string) =>
      Effect.gen(function* () {
        yield* storage.exclusive(
          Effect.gen(function* () {
            const fresh = (yield* storage.get(`c:${child}`)) === undefined;
            yield* keepPath(path);
            yield* storage.put({ [`c:${child}`]: true });
            if (!fresh) return;
            yield* trace("child", { path, child });
            // Linked while sweeps run: it takes part in each one's current phase.
            for (const { target, sweep } of yield* sweeps) {
              // The root sweeps only the subtrees of the sources the consumer reads.
              const sources = path === "" ? (yield* planFor(target))?.sources : undefined;
              if (sources !== undefined && !sources.includes(sourceOfPath(child) ?? "")) continue;
              // After this node reported, the child is still told, but not waited for.
              const children = sweep.children.includes(child)
                ? sweep.children
                : [...sweep.children, child];
              yield* storage.put({ [sweepKey(target)]: { ...sweep, children, told: false } });
              yield* jobs.schedule(`step:${target}`, 0);
            }
          }),
        );
        yield* ensureLinked(path);
      }),
    news: (path: string, targets: ReadonlyArray<string>, plans: Readonly<Record<string, Plan>>) =>
      storage.exclusive(
        Effect.gen(function* () {
          const known = (yield* storage.get<Array<string>>("known")) ?? [];
          const fresh = targets.filter((target) => !known.includes(target));
          for (const target of targets) yield* keepPlan(target, plans[target]);
          if (fresh.length === 0) return;
          yield* keepPath(path);
          yield* storage.put({ known: [...known, ...fresh] });
          if (path !== "") return yield* jobs.schedule("news", 0);
          for (const target of fresh) yield* begin(path, target, "discover");
        }),
      ),
    sweep: (path: string, target: string, phase: Sweep["phase"], plan: Plan | undefined) =>
      storage.exclusive(
        Effect.gen(function* () {
          yield* keepPlan(target, plan);
          const current = yield* getSweep(target);
          if (current && PHASES.indexOf(current.phase) >= PHASES.indexOf(phase)) return;
          yield* begin(path, target, phase);
        }),
      ),
    report: (
      path: string,
      target: string,
      phase: "discover" | "ready",
      child: string,
      trail: ReadonlyArray<Hop> = [],
    ) =>
      storage.exclusive(
        Effect.gen(function* () {
          const sweep = yield* getSweep(target);
          if (!sweep || sweep.phase !== phase) return;
          const at = yield* Clock.currentTimeMillis;
          yield* storage.put({ [`${reportPrefix(target, phase)}${child}`]: { at, trail } });
          yield* settle(path, target);
        }),
      ),
    settled: (path: string, target: string, ref: SourceRef) =>
      Effect.gen(function* () {
        const split = yield* storage.exclusive(
          Effect.gen(function* () {
            yield* keepPath(path);
            yield* storage.put({ [settledKey(target, ref)]: yield* Clock.currentTimeMillis });
            yield* storage.put({ [lastSettledKey(target)]: yield* Clock.currentTimeMillis });
            yield* storage.delete([`${unsettledPrefix(target)}${refKey(ref)}`]);
            yield* settle(path, target);
            return (yield* storage.get<boolean>("split")) === true;
          }),
        );
        // An instance reports to the leaf it first listed in: pass it down to where it is now.
        if (split) yield* net.node.settled(childFor(path, ref), target, ref);
      }),
    phase: (_path: string, target: string) =>
      Effect.gen(function* () {
        if (yield* storage.get(`done:${enc(target)}`)) return "complete" as Phase;
        return ((yield* getSweep(target))?.phase ?? "unknown") as Phase;
      }),
    status: (_path: string) =>
      Effect.gen(function* () {
        const complete = (yield* storage.get<Array<string>>("complete")) ?? [];
        const known = (yield* storage.get<Array<string>>("known")) ?? [];
        return {
          complete,
          running: known.filter((target) => !complete.includes(target)),
        } satisfies Status;
      }),

    /** Run a scheduled job by its id. */
    run: (id: string) =>
      Effect.gen(function* () {
        const path = (yield* storage.get<string>("path")) ?? "";
        const parent = parentOf(path);
        if (id === "news") {
          const known = (yield* storage.get<Array<string>>("known")) ?? [];
          const plans: Record<string, Plan> = {};
          for (const target of known) {
            const plan = yield* planFor(target);
            if (plan !== undefined) plans[target] = plan;
          }
          yield* net.node.news(parent, known, plans);
          return yield* retry.clear(id);
        }
        const [kind, ...rest] = id.split(":");
        const target = rest.join(":");
        if (kind === "step") return yield* step(path, target);
        if (kind === "late") return yield* late(path, target);
        if (id === "split") return yield* split(path);
        if (kind === "report") {
          const sweep = yield* getSweep(target);
          if (sweep?.reported && sweep.phase !== "complete") {
            const trail = yield* storage.get<ReadonlyArray<Hop>>(hopKey(target, sweep.phase));
            yield* net.node.report(
              parent,
              target,
              sweep.phase,
              path,
              Array.isArray(trail) ? trail : [],
            );
          }
          yield* retry.clear(id);
        }
      }).pipe(
        // A remote failure asks again after a fixed wait, rather than failing the job.
        Effect.catchCause(() => retry.later(id, RETRY_MS)),
      ),
  };
};

export type Node = ReturnType<typeof makeNode>;

// ---------------------------------------------------------------- host glue

/**
 * Route a commit's deliveries (an aggregate's events, or a view key's entries):
 * live to caught-up consumers, and through the backfill to lagging ones. Call
 * inside the commit's exclusive section; returns what to send and the new cursors.
 */
export const routeCommit = (
  source: Source,
  targets: ReadonlyArray<string>,
  routed: Routed | undefined,
  before: number,
  after: number,
  deliveries: ReadonlyArray<Delivery>,
) =>
  Effect.gen(function* () {
    const live = routeLive(targets, routed, before, after, deliveries);
    const send = [...live.deliveries];
    // An instance with no cursors predates catch-up: everything is live.
    if (routed !== undefined) {
      for (const target of targets) {
        if ((routed[target] ?? 0) === before) continue;
        const withheld = deliveries.filter((delivery) => targetId(delivery.target) === target);
        send.push(...(yield* source.onCommit(target, withheld, before, after)));
      }
    }
    return { send: send as ReadonlyArray<Delivery>, routed: live.routed };
  });

/** Route stored rows to one target only, as history: each row's seq and its deliveries. */
export const routeRows = <Row>(
  replay: (input: ReplayInput<Row>) => ReplayResult,
  id: string,
  targets: ReadonlyArray<string>,
  target: string,
  rows: ReadonlyArray<Row>,
  seqOf: (row: Row) => number,
) =>
  rows.map((row) => ({
    seq: seqOf(row),
    deliveries: replay({
      id,
      routed: Object.fromEntries(
        targets.map((t) => [t, t === target ? seqOf(row) - 1 : Number.MAX_SAFE_INTEGER]),
      ),
      rows: [row],
    }).deliveries,
  }));

/** A consumer's kind and name from its target id: `view:Name#2` is the view `Name`. */
export const consumerOf = (target: string) => {
  const [kind, rest] = target.split(/:(.*)/s) as [string, string];
  return { kind: kind as "view" | "projection", name: rest.replace(/#\d+$/, "") };
};
