import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recordStateStoreInit } from "../Telemetry/Metrics.ts";
import {
  DEPLOYMENT_TTL_MILLIS,
  DeploymentInProgress,
  DeploymentNotFound,
  DeploymentTokenInvalid,
  endTransition,
  shouldAbandonOpen,
  maxSeqOf,
  toPublicRecord,
  type DeploymentEvent,
  type DeploymentStore,
  type StoredDeploymentRecord,
} from "./Deployment.ts";
import { STATE_STORE_VERSION } from "./HttpStateApi.ts";
import type { ResourceState } from "./ResourceState.ts";
import {
  fencedWriteRejected,
  State,
  type PersistedState,
  type StateStoreError,
} from "./State.ts";

type StackId = string;
type StageId = string;
type Fqn = string;

/** Per-(stack, stage) deployment history for one in-memory instance. */
interface StageDeployments {
  /** Highest version ever allocated (versions start at 1). */
  counter: number;
  records: Map<number, StoredDeploymentRecord>;
  /** Journal per version, keyed by `seq` for idempotent appends. */
  events: Map<number, Map<number, DeploymentEvent>>;
}

export const inMemoryState = (
  initialState: Record<
    StackId,
    Record<StageId, Record<Fqn, ResourceState>>
  > = {},
  initialOutputs: Record<StackId, Record<StageId, unknown>> = {},
) =>
  Layer.effect(
    State,
    Effect.cached(
      InMemoryService(initialState, initialOutputs).pipe(recordStateStoreInit),
    ),
  );

export const InMemoryService = (
  state: Record<StackId, Record<StageId, Record<Fqn, ResourceState>>> = {},
  outputs: Record<StackId, Record<StageId, unknown>> = {},
) => {
  // Per-instance deployment history, keyed by `${stack}\u0000${stage}`.
  const deploymentState = new Map<string, StageDeployments>();

  const stageKey = (stack: string, stage: string) => `${stack}\u0000${stage}`;

  const stageDeployments = (stack: string, stage: string): StageDeployments => {
    const key = stageKey(stack, stage);
    let existing = deploymentState.get(key);
    if (existing === undefined) {
      existing = { counter: 0, records: new Map(), events: new Map() };
      deploymentState.set(key, existing);
    }
    return existing;
  };

  /**
   * Fencing check (see StateWriteFence in State.ts): a write carrying
   * `fence: F` is rejected once any deployment version > F was begun for
   * the stage. Returns the rejection error, or `undefined` when the write
   * may proceed. Synchronous against the same map `begin` mutates and
   * evaluated in the same step as the write — perfect fencing.
   */
  const fenceViolation = (request: {
    stack: string;
    stage: string;
    fence?: number;
  }): StateStoreError | undefined => {
    if (request.fence === undefined) {
      return undefined;
    }
    const newest =
      deploymentState.get(stageKey(request.stack, request.stage))?.counter ?? 0;
    return newest > request.fence
      ? fencedWriteRejected({
          stack: request.stack,
          stage: request.stage,
          fence: request.fence,
        })
      : undefined;
  };

  /** Look up an open-or-ended version and enforce the token. */
  const resolveRecord = (
    stack: string,
    stage: string,
    version: number,
    token: string,
  ) =>
    Effect.suspend(
      (): Effect.Effect<
        StoredDeploymentRecord,
        DeploymentNotFound | DeploymentTokenInvalid
      > => {
        const record = deploymentState
          .get(stageKey(stack, stage))
          ?.records.get(version);
        if (record === undefined) {
          return Effect.fail(new DeploymentNotFound({ stack, stage, version }));
        }
        if (record.token !== token) {
          return Effect.fail(
            new DeploymentTokenInvalid({ stack, stage, version }),
          );
        }
        return Effect.succeed(record);
      },
    );

  const deployments: DeploymentStore = {
    begin: ({ stack, stage, meta, ttlMillis, supersede }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const token = yield* Effect.sync(() => crypto.randomUUID());
        const ttl = ttlMillis ?? DEPLOYMENT_TTL_MILLIS;
        // Reconcile + live-check + allocate in one synchronous step so two
        // racing begins can never both succeed. (No blind-claim fast path
        // here — there is no I/O to skip; the scan IS the fast path.)
        return yield* Effect.suspend(() => {
          const ns = stageDeployments(stack, stage);
          for (const record of ns.records.values()) {
            if (record.endedAt === undefined) {
              // Shared takeover semantics: stale heartbeat, or a targeted
              // `supersede` of exactly this version.
              if (shouldAbandonOpen(record, now, ttl, supersede)) {
                record.endedAt = now;
                record.outcome = "abandoned";
              } else {
                return Effect.fail(
                  new DeploymentInProgress({
                    stack,
                    stage,
                    holder: toPublicRecord(record),
                  }),
                );
              }
            }
          }
          const version = ++ns.counter;
          ns.records.set(version, {
            stack,
            stage,
            version,
            meta: structuredClone(meta),
            startedAt: now,
            heartbeatAt: now,
            token,
          });
          ns.events.set(version, new Map());
          return Effect.succeed({ version, token });
        });
      }),
    appendEvents: ({ stack, stage, version, token, events }) =>
      Effect.gen(function* () {
        yield* resolveRecord(stack, stage, version, token);
        return yield* Effect.sync(() => {
          const ns = stageDeployments(stack, stage);
          let journal = ns.events.get(version);
          if (journal === undefined) {
            journal = new Map();
            ns.events.set(version, journal);
          }
          for (const event of events) {
            // Idempotent per seq: first write wins, retries are ignored.
            if (!journal.has(event.seq)) {
              journal.set(event.seq, structuredClone(event));
            }
          }
          return { ackedSeq: maxSeqOf([...journal.values()]) };
        });
      }),
    heartbeat: ({ stack, stage, version, token }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const record = yield* resolveRecord(stack, stage, version, token);
        yield* Effect.sync(() => {
          // Heartbeat against an ended deployment is a silent no-op.
          if (record.endedAt === undefined) {
            record.heartbeatAt = now;
          }
        });
      }),
    end: ({ stack, stage, version, token, outcome, summary }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const record = yield* resolveRecord(stack, stage, version, token);
        yield* Effect.sync(() => {
          // Shared close semantics: first outcome wins, ending an
          // "abandoned" version records "completed-late".
          const nextOutcome = endTransition(record, outcome);
          if (nextOutcome !== undefined) {
            record.endedAt = now;
            record.outcome = nextOutcome;
            if (summary !== undefined) {
              record.summary = structuredClone(summary);
            }
          }
        });
      }),
    list: ({ stack, stage, before, limit }) =>
      Effect.sync(() => {
        const ns = deploymentState.get(stageKey(stack, stage));
        if (ns === undefined) {
          return [];
        }
        let versions = Array.from(ns.records.keys()).sort((a, b) => b - a);
        if (before !== undefined) {
          versions = versions.filter((version) => version < before);
        }
        if (limit !== undefined) {
          versions = versions.slice(0, limit);
        }
        return versions.map((version) =>
          toPublicRecord(ns.records.get(version)!),
        );
      }),
    get: ({ stack, stage, version }) =>
      Effect.sync(() => {
        const record = deploymentState
          .get(stageKey(stack, stage))
          ?.records.get(version);
        return record === undefined ? undefined : toPublicRecord(record);
      }),
    readEvents: ({ stack, stage, version, fromSeq }) =>
      Effect.suspend(() => {
        const ns = deploymentState.get(stageKey(stack, stage));
        if (ns?.records.get(version) === undefined) {
          return Effect.fail(new DeploymentNotFound({ stack, stage, version }));
        }
        const journal = ns.events.get(version);
        const events =
          journal === undefined
            ? []
            : Array.from(journal.values())
                .filter((event) =>
                  fromSeq === undefined ? true : event.seq >= fromSeq,
                )
                .sort((a, b) => a.seq - b.seq)
                .map((event) => structuredClone(event));
        return Effect.succeed<readonly DeploymentEvent[]>(events);
      }),
  };

  return State.of(
    Effect.succeed({
      id: "inmemory",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () => Effect.succeed(Array.from(Object.keys(state))),
      listStages: (stack: string) =>
        Effect.succeed(
          Array.from(stack in state ? Object.keys(state[stack]) : []),
        ),
      get: ({
        stack,
        stage,
        fqn,
      }: {
        stack: string;
        stage: string;
        fqn: string;
      }) => Effect.succeed(state[stack]?.[stage]?.[fqn]),
      getReplacedResources: ({
        stack,
        stage,
      }: {
        stack: string;
        stage: string;
      }) =>
        Effect.succeed(
          Array.from(Object.values(state[stack]?.[stage] ?? {}) ?? []).filter(
            (s) => s.status === "replaced",
          ),
        ),
      set: <V extends PersistedState>({
        stack,
        stage,
        fqn,
        value,
        fence,
      }: {
        stack: string;
        stage: string;
        fqn: string;
        value: V;
        fence?: number;
      }) =>
        Effect.suspend(() => {
          const violation = fenceViolation({ stack, stage, fence });
          if (violation !== undefined) {
            return Effect.fail(violation);
          }
          const stackState = (state[stack] ??= {});
          const stageState = (stackState[stage] ??= {});
          stageState[fqn] = value as ResourceState;
          return Effect.succeed(value);
        }),
      delete: ({
        stack,
        stage,
        fqn,
        fence,
      }: {
        stack: string;
        stage: string;
        fqn: string;
        fence?: number;
      }) =>
        Effect.suspend(() => {
          const violation = fenceViolation({ stack, stage, fence });
          if (violation !== undefined) {
            return Effect.fail(violation);
          }
          delete state[stack]?.[stage]?.[fqn];
          return Effect.void;
        }),
      deleteStack: ({ stack, stage }: { stack: string; stage?: string }) =>
        Effect.sync(() => {
          if (stage === undefined) {
            delete state[stack];
            delete outputs[stack];
          } else {
            delete state[stack]?.[stage];
            delete outputs[stack]?.[stage];
          }
        }),
      list: ({ stack, stage }: { stack: string; stage: string }) =>
        Effect.succeed(
          Array.from(Object.keys(state[stack]?.[stage] ?? {}) ?? []),
        ),
      getOutput: ({ stack, stage }: { stack: string; stage: string }) =>
        Effect.succeed(outputs[stack]?.[stage]),
      setOutput: ({
        stack,
        stage,
        value,
        fence,
      }: {
        stack: string;
        stage: string;
        value: unknown;
        fence?: number;
      }) =>
        Effect.suspend(() => {
          const violation = fenceViolation({ stack, stage, fence });
          if (violation !== undefined) {
            return Effect.fail(violation);
          }
          const stackOutputs = (outputs[stack] ??= {});
          stackOutputs[stage] = value;
          return Effect.succeed(value);
        }),
      getAll: ({ stack, stage }: { stack: string; stage: string }) =>
        Effect.sync(
          (): ReadonlyMap<string, PersistedState> =>
            new Map(Object.entries(state[stack]?.[stage] ?? {})),
        ),
      deployments,
    }),
  );
};
