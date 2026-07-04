import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import type { ApplyEvent } from "../Cli/Event.ts";
import type {
  DeploymentEndOutcome,
  DeploymentEvent,
  DeploymentInProgress,
  DeploymentMeta,
  DeploymentSummary,
} from "./Deployment.ts";
import type { PersistedState, StateService, StateStoreError } from "./State.ts";

/**
 * The engine-side composition over {@link DeploymentStore}: one open
 * deployment version, a batched journal tee for apply events, a heartbeat
 * keeping the open marker live, and a {@link StateService} facade that
 * journals every engine state write alongside the head-state write.
 *
 * Robustness invariants:
 * - **`begin` is fail-closed.** It is the mutual-exclusion gate for the
 *   apply, so every failure aborts the deploy: {@link DeploymentInProgress}
 *   (a live holder exists) and `StateStoreError` (the store could not prove
 *   exclusivity) both propagate. A deploy never proceeds without the lock.
 * - **Once open, journaling must never fail or stall the deploy**: journal
 *   writes (append/heartbeat/end) are fire-and-forget with bounded retry;
 *   store errors are logged (`Effect.logWarning`) and swallowed. Losing the
 *   journal mid-flight loses observability, not correctness — the version
 *   was already claimed.
 * - Stores without `deployments` support (older/third-party) yield a no-op
 *   session: `version` is `undefined`, `state` is the store itself, and
 *   `emit`/`end` do nothing.
 * - The session is Scope-owned: if the scope closes before {@link end} was
 *   called (crash/interrupt path), the deployment is closed as
 *   `"interrupted"` by a finalizer backstop.
 */
export interface DeploymentSession {
  /**
   * The deployment version allocated by `begin`, or `undefined` when the
   * store has no deployments support (no-op session).
   */
  readonly version: number | undefined;
  /**
   * A {@link StateService} facade over the real store: `set`/`delete`/
   * `setOutput` for this session's `(stack, stage)` additionally journal a
   * status-level record (see {@link DeploymentStateSetPayload}); everything
   * else delegates untouched. For no-op sessions this IS the underlying
   * store.
   */
  readonly state: StateService;
  /**
   * Journal an apply event. Stamps the next `seq`, buffers, and flushes in
   * batches (every {@link FLUSH_INTERVAL} or {@link FLUSH_MAX_EVENTS}
   * events, whichever comes first). Never fails; events emitted after
   * {@link end} are dropped.
   */
  emit(event: ApplyEvent): Effect.Effect<void>;
  /**
   * Close the deployment: journals a `deployment-end` event, flushes the
   * remaining buffer (bounded ~3s), stops the heartbeat, and records the
   * outcome via `deployments.end`. Idempotent — the first call wins and
   * subsequent calls are no-ops. Never fails.
   */
  end(
    outcome: DeploymentEndOutcome,
    summary?: DeploymentSummary,
  ): Effect.Effect<void>;
}

/** Journal payload for the session-lifecycle bookends. */
export interface DeploymentStartPayload {
  kind: "deployment-start";
  command: DeploymentMeta["command"];
}

export interface DeploymentEndPayload {
  kind: "deployment-end";
  outcome: DeploymentEndOutcome;
  summary?: DeploymentSummary;
}

/**
 * Journal payload for an engine state write teed by the facade. Carries
 * ONLY status-level info (never full props/attr bodies — those live in head
 * state) plus a `before` snapshot of the prior status when a row existed.
 */
export interface DeploymentStateSetPayload {
  kind: "state-set";
  fqn: string;
  status: string;
  before?: { status: string };
}

export interface DeploymentStateDeletePayload {
  kind: "state-delete";
  fqn: string;
  before?: { status: string };
}

export interface DeploymentOutputSetPayload {
  kind: "output-set";
}

/**
 * Everything a {@link DeploymentSession} writes into the journal. Apply
 * events are journaled verbatim as payloads (the envelope duplicates their
 * `ts`/`fqn` for cheap store-side filtering).
 */
export type DeploymentSessionPayload =
  | DeploymentStartPayload
  | DeploymentEndPayload
  | DeploymentStateSetPayload
  | DeploymentStateDeletePayload
  | DeploymentOutputSetPayload
  | ApplyEvent;

/** Flush the journal buffer at least this often. */
const FLUSH_INTERVAL = "1 second";
/** ... or as soon as this many events are buffered, whichever comes first. */
const FLUSH_MAX_EVENTS = 50;
/** Heartbeat cadence for the open marker (TTL default is 60s). */
const HEARTBEAT_INTERVAL = "10 seconds";
/** How long `end` waits for the final flush before giving up on it. */
const END_FLUSH_BUDGET = "3 seconds";

/**
 * Open a {@link DeploymentSession} for `(stack, stage)` against `store`.
 *
 * Feature-detects `store.deployments`: absent → a no-op session (version
 * `undefined`, `state === store`, `emit`/`end` are `Effect.void`). Present →
 * `begin`s a new version ({@link DeploymentInProgress} propagates — that is
 * the concurrent-deploy protection), journals a `deployment-start` event as
 * seq 1, forks a Scope-owned heartbeat and interval flusher, and registers a
 * finalizer that closes the deployment as `"interrupted"` if the scope ends
 * before {@link DeploymentSession.end} was called.
 */
export const makeDeploymentSession: (options: {
  store: StateService;
  stack: string;
  stage: string;
  meta: DeploymentMeta;
  /**
   * Targeted takeover — passed through to `deployments.begin`. Abandons
   * exactly this open version (the caller proved the holder is dead)
   * before claiming; any other live open still fails
   * {@link DeploymentInProgress}.
   */
  supersede?: number;
}) => Effect.Effect<
  DeploymentSession,
  DeploymentInProgress | StateStoreError,
  Scope.Scope
> = Effect.fn("makeDeploymentSession")(function* (options: {
  store: StateService;
  stack: string;
  stage: string;
  meta: DeploymentMeta;
  supersede?: number;
}) {
  const { store, stack, stage, meta, supersede } = options;
  const deployments = store.deployments;

  if (deployments === undefined) {
    // Third-party / older store: journaling is a total no-op.
    const noop: DeploymentSession = {
      version: undefined,
      state: store,
      emit: () => Effect.void,
      end: () => Effect.void,
    };
    return noop;
  }

  const { version, token } = yield* deployments.begin({
    stack,
    stage,
    meta,
    supersede,
  });

  const warn = (what: string) => (cause: unknown) =>
    Effect.logWarning(
      `alchemy: deployment journal ${what} failed for ${stack}/${stage} v${version} (deploy unaffected)`,
      cause,
    );

  // ── journal buffer ──────────────────────────────────────────────────────
  // seq is a monotonic in-session counter starting at 1 (deployment-start).
  // The buffer is drained by the interval flusher, the size threshold, and
  // `end`. Batches are disjoint (the splice below is synchronous), and
  // `appendEvents` is idempotent per seq, so overlapping flushes are safe.
  let nextSeq = 1;
  let buffer: DeploymentEvent[] = [];
  let ended = false;

  const flush: Effect.Effect<void> = Effect.suspend(() => {
    if (buffer.length === 0) {
      return Effect.void;
    }
    const batch = buffer;
    buffer = [];
    return deployments
      .appendEvents({ stack, stage, version, token, events: batch })
      .pipe(
        Effect.retry({ times: 2 }),
        Effect.asVoid,
        Effect.catchCause(warn("append")),
      );
  });

  /** Buffer one journal event (fire-and-forget; dropped after `end`). */
  const enqueue = (event: Omit<DeploymentEvent, "seq">) =>
    Effect.suspend(() => {
      if (ended) {
        return Effect.void;
      }
      buffer.push({ seq: nextSeq++, ...event });
      return buffer.length >= FLUSH_MAX_EVENTS ? flush : Effect.void;
    });

  /** Journal a session/state payload, stamping `ts` at enqueue time. */
  const journal = (payload: DeploymentSessionPayload, fqn?: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (ts) =>
      enqueue({ ts, fqn, payload }),
    );

  // seq 1: the deployment-start bookend.
  yield* journal({ kind: "deployment-start", command: meta.command });

  const emit = (event: ApplyEvent) =>
    // Apply events already carry their emission ts — mirror it onto the
    // journal envelope instead of re-stamping at enqueue time.
    typeof event.ts === "number"
      ? enqueue({ ts: event.ts, fqn: event.fqn, payload: event })
      : journal(event, event.fqn);

  const end = (
    outcome: DeploymentEndOutcome,
    summary?: DeploymentSummary,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (ended) {
        return;
      }
      // Latch synchronously so a concurrent end() (or the scope finalizer
      // racing an explicit call) can never double-close.
      ended = true;
      const ts = yield* Clock.currentTimeMillis;
      buffer.push({
        seq: nextSeq++,
        ts,
        payload: {
          kind: "deployment-end",
          outcome,
          ...(summary !== undefined ? { summary } : {}),
        } satisfies DeploymentEndPayload,
      });
      yield* Fiber.interrupt(heartbeatFiber);
      yield* flush.pipe(
        Effect.timeout(END_FLUSH_BUDGET),
        Effect.catchCause(warn("final flush")),
      );
      yield* deployments
        .end({ stack, stage, version, token, outcome, summary })
        .pipe(Effect.catchCause(warn("end")));
    });

  // Backstop: a scope that closes without end() (crash, interrupt, dev-mode
  // swallowed failure) still closes the deployment record. Registered BEFORE
  // the fibers are forked so it runs AFTER they are interrupted (finalizers
  // are LIFO) — the final flush never races the interval flusher.
  yield* Effect.addFinalizer(() => end("interrupted"));

  const heartbeatFiber = yield* Effect.forkScoped(
    deployments
      .heartbeat({ stack, stage, version, token })
      .pipe(
        Effect.catchCause(warn("heartbeat")),
        Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)),
      ),
  );

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(FLUSH_INTERVAL);
        yield* flush;
      }
    }),
  );

  // ── the state facade ────────────────────────────────────────────────────
  // Same StateService, but engine writes for THIS (stack, stage) also leave
  // a status-level journal record AND carry the session's version as a
  // fencing token (see StateWriteFence in State.ts): if a newer deployment
  // has begun — this session is a zombie whose lease lapsed — the store
  // rejects the write and the failure aborts the stale apply. The
  // before-image read is best-effort: journaling must never fail (or
  // reorder) the head write.
  const priorStatus = (request: {
    stack: string;
    stage: string;
    fqn: string;
  }) =>
    store.get(request).pipe(
      Effect.map((prior) =>
        prior === undefined ? undefined : { status: String(prior.status) },
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const mine = (request: { stack: string; stage: string }) =>
    request.stack === stack && request.stage === stage && !ended;

  const facade: StateService = {
    ...store,
    set: <V extends PersistedState>(request: {
      stack: string;
      stage: string;
      fqn: string;
      value: V;
    }) =>
      Effect.gen(function* () {
        if (!mine(request)) {
          return yield* store.set(request);
        }
        const before = yield* priorStatus(request);
        const value = yield* store.set({ ...request, fence: version });
        yield* journal(
          {
            kind: "state-set",
            fqn: request.fqn,
            status: String(request.value.status),
            ...(before !== undefined ? { before } : {}),
          },
          request.fqn,
        );
        return value;
      }),
    delete: (request) =>
      Effect.gen(function* () {
        if (!mine(request)) {
          return yield* store.delete(request);
        }
        const before = yield* priorStatus(request);
        yield* store.delete({ ...request, fence: version });
        yield* journal(
          {
            kind: "state-delete",
            fqn: request.fqn,
            ...(before !== undefined ? { before } : {}),
          },
          request.fqn,
        );
      }),
    setOutput: (request) =>
      Effect.gen(function* () {
        if (!mine(request)) {
          return yield* store.setOutput(request);
        }
        const value = yield* store.setOutput({ ...request, fence: version });
        yield* journal({ kind: "output-set" });
        return value;
      }),
  };

  const session: DeploymentSession = {
    version,
    state: facade,
    emit,
    end,
  };
  return session;
});
