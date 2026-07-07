import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ApplyEvent } from "../Cli/Event.ts";
import type { DeploymentMeta } from "../State/Deployment.ts";
import type { DeploymentSessionPayload } from "../State/DeploymentSession.ts";
import type { PersistedState, StateService } from "../State/State.ts";
import {
  applyDeploymentRecord,
  restoreEdges as restoreEdgesFold,
  applyEvent as applyEventFold,
  applyPlan as applyPlanFold,
  applyStructure as applyStructureFold,
  clearApproval as clearApprovalFold,
  foldJournal,
  makeDocument,
  setApproval as setApprovalFold,
  setMeta as setMetaFold,
  setOutputs,
  snapshotOf,
  type DeploymentDocument,
  type DocumentApproval,
  type DocumentMeta,
  type DocumentPatch,
  type DocumentEdge,
  type DocumentSnapshot,
  type Mutation,
} from "./Document.ts";
import { applyStates, upsertNodeFromState } from "./DocumentStates.ts";
import type { DashboardPlan } from "./PlanJson.ts";
import type { StackStructure } from "./Scene.ts";

/**
 * Dashboard v2 document host (layer C, in-process transport): owns ONE
 * mutable {@link DeploymentDocument} per `(stack, stage)` and turns every
 * fold mutation into debounced patch frames for subscribers.
 *
 * The host is the thin glue between the durable spine (the state store and
 * its `deployments` journal) and the pure document core: it reads, the fold
 * computes, subscribers receive `snapshot`-then-`patches` frames. No
 * rendering semantics live here.
 */

/** One frame of the v2 wire protocol (SSE `data:` payload). */
export type DocumentFrame =
  | { kind: "snapshot"; snapshot: DocumentSnapshot }
  | { kind: "patches"; patches: DocumentPatch[] };

export interface DocumentHostOptions {
  state: StateService;
  stack: string;
  stage: string;
  /**
   * Patch frames are coalesced for this long before broadcasting, so a
   * burst of apply events becomes one frame.
   * @default 40 (milliseconds)
   */
  debounceMillis?: number;
}

export interface DocumentHost {
  readonly stage: string;
  /** The live document (read-only outside the host's own mutators). */
  readonly document: DeploymentDocument;
  /** A JSON-safe deep copy of the current document. */
  readonly snapshot: () => DocumentSnapshot;
  /**
   * Per-subscriber frame stream: one `snapshot` frame (current state at
   * attach), then live `patches` frames. Patches folded between the
   * subscription and the snapshot may be delivered again — their
   * `revision` is ≤ the snapshot's, so clients skip them; a patch whose
   * revision exceeds `known + 1` signals a gap and the client re-requests
   * a snapshot.
   */
  readonly frames: Effect.Effect<
    Stream.Stream<DocumentFrame>,
    never,
    Scope.Scope
  >;
  /** Fold one live event (the `/api/apply/event` ingest path). */
  readonly applyEvent: (
    event: ApplyEvent | DeploymentSessionPayload,
  ) => Effect.Effect<void>;
  /** Overlay a computed plan (from the server's plan worker). */
  readonly applyPlan: (plan: DashboardPlan) => Effect.Effect<void>;
  /**
   * Re-add previously captured edges whose endpoints still exist — keeps
   * the topology stable across the post-destroy states rebuild.
   */
  readonly restoreEdges: (
    edges: readonly DocumentEdge[],
  ) => Effect.Effect<void>;
  /** Overlay the stack's shape (from the server's structure fast-pass). */
  readonly applyStructure: (structure: StackStructure) => Effect.Effect<void>;
  /**
   * Re-read persisted states and rebuild the structural baseline (retires
   * plan/structure ghosts — the caller re-applies plan/structure passes).
   */
  readonly refreshStates: () => Effect.Effect<void>;
  /** Re-read the newest deployment record (begin/end/heartbeat changes). */
  readonly refreshDeployment: () => Effect.Effect<void>;
  /** Re-read stack outputs into the document. */
  readonly refreshOutputs: () => Effect.Effect<void>;
  /**
   * A live apply session began (`/api/apply/start`): reset the
   * per-deployment trackers via a synthetic `deployment-start`, then attach
   * the journal-backed record (version, initiator) when the store has one.
   */
  readonly deploymentStarted: (
    command?: DeploymentMeta["command"],
  ) => Effect.Effect<void>;
  /**
   * A live apply session finished (`/api/apply/done`): refresh the record,
   * waiting briefly for the engine's `deployments.end` to land; if the
   * persisted end still hasn't surfaced (remote stores are eventually
   * consistent and the CLI exits shortly after done), synthesize the end
   * with the tee-reported `outcome` so the run settles NOW.
   */
  readonly deploymentDone: (
    outcome?: "succeeded" | "failed",
  ) => Effect.Effect<void>;
  readonly setApproval: (approval: { plan: unknown }) => Effect.Effect<void>;
  readonly clearApproval: () => Effect.Effect<void>;
  readonly setMeta: (meta: Partial<DocumentMeta>) => Effect.Effect<void>;
}

/**
 * Create and hydrate a host. Hydration order (matches the fold contract):
 *
 * 1. persisted states (`getAll`, falling back to `list` + `get`)
 * 2. the newest deployment record + a full journal re-fold — an OPEN record
 *    means the server (re)started mid-deploy and the fold rebuilds the
 *    in-flight picture; a CLOSED record restores the last deployment's
 *    decorations/op-spans (v1 kept these only in process memory)
 * 3. stack outputs
 *
 * Journal catch-up vs the live tee: the journal's `seq` numbers every
 * payload (deployment bookends, state writes, apply events) while the HTTP
 * tee's `seq` counts only Cli-emitted apply events, so the two sequences
 * are not comparable and exact dedupe is not feasible. The overlap window
 * (an event journaled before hydration's `readEvents` but POSTed after the
 * host was registered) is tiny and double-folding is benign: decorations
 * and op-spans are idempotent upserts; at worst a timeline/feed line
 * repeats once.
 *
 * The returned host forks its patch flusher on the CURRENT scope — pass
 * the server's scope, not a request's.
 */
export const make: (
  options: DocumentHostOptions,
) => Effect.Effect<DocumentHost, never, Scope.Scope> = Effect.fn(
  "DocumentHost.make",
)(function* (options: DocumentHostOptions) {
  const { state, stack, stage } = options;
  const debounce = options.debounceMillis ?? 40;

  const doc = makeDocument({ stack, stage });
  const pubsub = yield* PubSub.unbounded<DocumentFrame>();
  const wake = yield* Queue.unbounded<void>();
  const pending: DocumentPatch[] = [];

  /** Collect a mutation's patches and schedule a debounced broadcast. */
  const record = (mutation: Mutation): Effect.Effect<void> => {
    if (mutation.patches.length === 0) {
      return Effect.void;
    }
    pending.push(...mutation.patches);
    return Queue.offer(wake, undefined).pipe(Effect.asVoid);
  };

  // Flusher: coalesce all patches folded within the debounce window into a
  // single frame. Extra wake signals just cause an empty (skipped) cycle.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (;;) {
        yield* Queue.take(wake);
        yield* Effect.sleep(Duration.millis(debounce));
        const batch = pending.splice(0, pending.length);
        if (batch.length > 0) {
          yield* PubSub.publish(pubsub, { kind: "patches", patches: batch });
        }
      }
    }).pipe(Effect.ignore),
  );

  // ── store reads (all best-effort: a flaky backend degrades, never fails) ─
  const readStates: Effect.Effect<PersistedState[] | undefined> = Effect.gen(
    function* () {
      if (state.getAll !== undefined) {
        return yield* state.getAll({ stack, stage }).pipe(
          Effect.map((all) => [...all.values()]),
          Effect.timeout("20 seconds"),
          Effect.orElseSucceed(() => undefined),
        );
      }
      const fqns = yield* state.list({ stack, stage }).pipe(
        Effect.timeout("20 seconds"),
        Effect.orElseSucceed(() => undefined),
      );
      if (fqns === undefined) {
        return undefined;
      }
      const states = yield* Effect.forEach(
        fqns,
        (fqn) =>
          state.get({ stack, stage, fqn }).pipe(
            Effect.timeout("20 seconds"),
            Effect.orElseSucceed(() => undefined),
          ),
        { concurrency: 16 },
      );
      return states.filter((s): s is PersistedState => s !== undefined);
    },
  );

  const refreshStates = () =>
    Effect.gen(function* () {
      const states = yield* readStates;
      if (states === undefined) {
        return;
      }
      // Nodes whose FRESH verdict this run says they exist (created,
      // updated, replaced, ran) must survive the rebuild even when the
      // readback misses them — remote stores are eventually consistent
      // and can lag the writes the run just made. Deleted/retained/
      // skipped verdicts don't protect: retiring those is the point.
      const keep = new Set<string>();
      const startedAt = doc.deployment?.startedAt;
      if (startedAt !== undefined) {
        for (const [fqn, decoration] of doc.decorations) {
          if (
            decoration.at >= startedAt &&
            (decoration.applyResult === "created" ||
              decoration.applyResult === "updated" ||
              decoration.applyResult === "replaced" ||
              decoration.applyResult === "ran")
          ) {
            keep.add(fqn);
          }
        }
      }
      yield* record(applyStates(doc, states, keep));
    });

  const newestRecord = Effect.gen(function* () {
    const deployments = state.deployments;
    if (deployments === undefined) {
      return undefined;
    }
    const records = yield* deployments
      .list({ stack, stage, limit: 1 })
      .pipe(Effect.orElseSucceed(() => []));
    return records[0];
  });

  const refreshDeployment = () =>
    Effect.gen(function* () {
      const record_ = yield* newestRecord;
      if (record_ === undefined) {
        return;
      }
      // While the document says a run is underway (the synthetic bookend
      // from apply-start), the store may still be returning the PREVIOUS
      // deployment — the engine's `deployments.begin` commits concurrently
      // with the reporter's start post. Folding that older ended record in
      // would flip live→false mid-run (a phantom "run finished") and stop
      // the live-record watcher for good. A record that ended BEFORE our
      // run began is definitionally not this run — skip it; the real
      // record is picked up on a later poll.
      if (
        doc.deployment?.live === true &&
        record_.endedAt !== undefined &&
        record_.endedAt < doc.deployment.startedAt
      ) {
        return;
      }
      yield* record(applyDeploymentRecord(doc, record_));
    });

  const refreshOutputs = () =>
    Effect.gen(function* () {
      const outputs = yield* state
        .getOutput({ stack, stage })
        .pipe(Effect.orElseSucceed(() => undefined));
      if (outputs !== undefined) {
        yield* record(setOutputs(doc, outputs));
      }
    });

  // statuses whose arrival means the resource's persisted state (attrs,
  // bindings) just changed — worth a targeted re-read so outputs appear
  // the moment EACH node completes, not when the whole run refreshes
  const TERMINAL_STATUSES = new Set([
    "created",
    "updated",
    "replaced",
    "ran",
    "retained",
  ]);

  const applyEvent = (event: ApplyEvent | DeploymentSessionPayload) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      yield* record(applyEventFold(doc, event, at));
      // progressive convergence: merge this one resource's fresh state
      // (best-effort — a flaky read just means the final refresh covers it)
      if (
        event.kind === "status-change" &&
        typeof (event as { fqn?: unknown }).fqn === "string" &&
        TERMINAL_STATUSES.has((event as { status: string }).status)
      ) {
        const fqn = (event as { fqn: string }).fqn;
        const fresh = yield* state
          .get({ stack, stage, fqn })
          .pipe(Effect.orElseSucceed(() => undefined));
        if (fresh !== undefined) {
          yield* record(upsertNodeFromState(doc, fresh));
        }
      }
    });

  const deploymentStarted = (command: DeploymentMeta["command"] = "deploy") =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      // synthetic bookend: the live tee never sends deployment-start (it is
      // a journal payload), but the fold's per-deployment resets (timelines,
      // pending trackers, op spans, annotations) must still run
      yield* record(
        applyEventFold(doc, { kind: "deployment-start", command }, at),
      );
      // attach the authoritative record (version, initiator, heartbeat)
      yield* refreshDeployment();
    });

  const deploymentDone = (outcome?: "succeeded" | "failed") =>
    Effect.gen(function* () {
      yield* refreshDeployment();
      if (doc.deployment !== undefined && doc.deployment.live) {
        // the engine's `deployments.end` races the reporter's done post —
        // give it one beat
        yield* Effect.sleep("500 millis");
        yield* refreshDeployment();
      }
      if (doc.deployment !== undefined && doc.deployment.live) {
        // The persisted end never surfaced: remote stores are eventually
        // consistent and the CLI exits ~2s after done, so waiting longer
        // loses the race anyway. The done post itself is authoritative
        // that the run ENDED — synthesize the end bookend. Outcome comes
        // from the tee; fall back to what the decorations say.
        const at = yield* Clock.currentTimeMillis;
        const derived =
          outcome ??
          ([...doc.decorations.values()].some(
            (d) => d.applyResult === "failed" || d.status === "fail",
          )
            ? "failed"
            : "succeeded");
        yield* record(
          applyEventFold(doc, { kind: "deployment-end", outcome: derived }, at),
        );
      }
    });

  const frames: Effect.Effect<
    Stream.Stream<DocumentFrame>,
    never,
    Scope.Scope
  > = Effect.gen(function* () {
    // drain the debounce buffer to the EXISTING subscribers first so the
    // new subscriber doesn't receive pre-snapshot patches...
    const buffered = pending.splice(0, pending.length);
    if (buffered.length > 0) {
      yield* PubSub.publish(pubsub, { kind: "patches", patches: buffered });
    }
    // ...then subscribe BEFORE snapshotting so nothing folded after the
    // snapshot is missed; any frame duplicated across the boundary carries
    // revision ≤ snapshot's and clients skip it
    const subscription = yield* PubSub.subscribe(pubsub);
    const snapshot = snapshotOf(doc);
    return Stream.make({ kind: "snapshot", snapshot } as DocumentFrame).pipe(
      Stream.concat(Stream.fromSubscription(subscription)),
    );
  });

  // ── hydrate ──────────────────────────────────────────────────────────────
  const stages = yield* state
    .listStages(stack)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (stages !== undefined) {
    yield* record(
      setMetaFold(doc, {
        stages: [...new Set([...stages, stage])].sort(),
      }),
    );
  }
  yield* refreshStates();
  const newest = yield* newestRecord;
  if (newest !== undefined && state.deployments !== undefined) {
    yield* record(applyDeploymentRecord(doc, newest));
    const events = yield* state.deployments
      .readEvents({ stack, stage, version: newest.version })
      .pipe(Effect.orElseSucceed(() => []));
    yield* record(foldJournal(doc, events));
    // the journal's deployment-start/end payloads rebuilt the record from
    // partial data; re-assert the store's authoritative record
    yield* record(applyDeploymentRecord(doc, newest));
  }
  yield* refreshOutputs();
  // hydration ran before any subscriber could attach — its patches have no
  // audience and every future subscriber's snapshot already includes them
  pending.splice(0, pending.length);

  // Live-record watcher: while the document shows an open deployment, poll
  // the store until it closes. The apply/done tee can race the engine's
  // `deployments.end` (or the deploy may not be teeing at all — another
  // host, a killed process), and a record that ends out-of-band would
  // otherwise stay `live: true` in the document forever.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep("3 seconds");
        if (doc.deployment !== undefined && doc.deployment.live) {
          yield* refreshDeployment().pipe(Effect.ignore);
        }
      }
    }).pipe(Effect.ignore),
  );

  const host: DocumentHost = {
    stage,
    document: doc,
    snapshot: () => snapshotOf(doc),
    frames,
    applyEvent,
    applyPlan: (plan) => record(applyPlanFold(doc, plan)),
    applyStructure: (structure) => record(applyStructureFold(doc, structure)),
    restoreEdges: (edges) => record(restoreEdgesFold(doc, edges)),
    refreshStates,
    refreshDeployment,
    refreshOutputs,
    deploymentStarted,
    deploymentDone,
    setApproval: (approval) =>
      Effect.gen(function* () {
        const requestedAt = yield* Clock.currentTimeMillis;
        const full: DocumentApproval = { plan: approval.plan, requestedAt };
        yield* record(setApprovalFold(doc, full));
      }),
    clearApproval: () => record(clearApprovalFold(doc)),
    setMeta: (meta) => record(setMetaFold(doc, meta)),
  };
  return host;
});
