import type {
  DeploymentEvent,
  DeploymentMeta,
  DeploymentStore,
  ResourceState,
  StateService,
} from "@/State";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

export interface DeploymentStoreConformanceOptions {
  /** Label for the describe block, e.g. "InMemory deployments". */
  label: string;
  /**
   * Build a fresh {@link StateService} over the SAME underlying storage.
   * Called multiple times by persistence cases, so two invocations must
   * observe each other's writes when `persistent` is true.
   *
   * Requirements must be pre-provided by the caller (e.g. via
   * `Effect.provide`) so the returned effect runs in the plain test runtime.
   */
  make: () => Effect.Effect<StateService, unknown, unknown>;
  /** Whether data must survive re-`make` (true for FS-backed stores). */
  persistent: boolean;
}

/**
 * Shared conformance suite for {@link DeploymentStore} implementations.
 *
 * Every case uses its own unique `(stack, stage)` pair so the suite is safe
 * against shared/non-resettable backends and vitest's concurrent sequencing.
 *
 * NOTE: runs under `it.effect`'s TestClock — `Clock.currentTimeMillis` is 0
 * and does not advance. Stale-open behavior is exercised via `ttlMillis: 0`
 * (always stale) vs. the default TTL (always live).
 */
export const deploymentStoreConformance = (
  options: DeploymentStoreConformanceOptions,
): void => {
  const slug = options.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Callers pre-provide requirements; erase the (unknown) R for it.effect.
  const makeState = () =>
    options.make() as Effect.Effect<StateService, unknown, never>;

  const makeStore = Effect.fn(function* () {
    const state = yield* makeState();
    const deployments = state.deployments;
    if (deployments === undefined) {
      return yield* Effect.die(
        `state store '${options.label}' does not implement deployments`,
      );
    }
    return { state, deployments };
  });

  /** Unique (stack, stage) per case so cases never interfere. */
  const ids = (name: string) => ({
    stack: `${slug}-conformance`,
    stage: name,
  });

  const meta = (user = "conformance"): DeploymentMeta => ({
    command: "deploy",
    initiator: { user },
  });

  const event = (seq: number, payload?: unknown): DeploymentEvent => ({
    seq,
    ts: seq * 10,
    payload: payload ?? { kind: "note", seq },
  });

  const resource = (fqn: string): ResourceState => ({
    resourceType: "test:resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: {},
    attr: {},
  });

  describe(options.label, () => {
    it.effect("begin allocates version 1, then 2 after end (monotonic)", () =>
      Effect.gen(function* () {
        const { deployments } = yield* makeStore();
        const { stack, stage } = ids("monotonic");

        const first = yield* deployments.begin({ stack, stage, meta: meta() });
        expect(first.version).toBe(1);
        expect(typeof first.token).toBe("string");
        expect(first.token.length).toBeGreaterThan(0);

        yield* deployments.end({
          stack,
          stage,
          version: first.version,
          token: first.token,
          outcome: "succeeded",
        });

        const second = yield* deployments.begin({ stack, stage, meta: meta() });
        expect(second.version).toBe(2);
        expect(second.token).not.toBe(first.token);
      }),
    );

    it.effect(
      "begin fails DeploymentInProgress with the holder record while a live open exists",
      () =>
        Effect.gen(function* () {
          const { deployments } = yield* makeStore();
          const { stack, stage } = ids("in-progress");

          const first = yield* deployments.begin({
            stack,
            stage,
            meta: meta("first-deployer"),
          });

          const result = yield* Effect.result(
            deployments.begin({ stack, stage, meta: meta("second-deployer") }),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            const failure = result.failure;
            expect(failure._tag).toBe("DeploymentInProgress");
            if (failure._tag === "DeploymentInProgress") {
              expect(failure.stack).toBe(stack);
              expect(failure.stage).toBe(stage);
              expect(failure.holder.version).toBe(first.version);
              expect(failure.holder.meta.initiator?.user).toBe(
                "first-deployer",
              );
              expect(failure.holder.outcome).toBeUndefined();
              expect("token" in failure.holder).toBe(false);
            }
          }
        }),
    );

    it.effect(
      "begin with ttlMillis: 0 reconciles the stale open to abandoned and allocates the next version",
      () =>
        Effect.gen(function* () {
          const { deployments } = yield* makeStore();
          const { stack, stage } = ids("stale-reconcile");

          const first = yield* deployments.begin({
            stack,
            stage,
            meta: meta(),
          });
          expect(first.version).toBe(1);

          const second = yield* deployments.begin({
            stack,
            stage,
            meta: meta(),
            ttlMillis: 0,
          });
          expect(second.version).toBe(2);

          const abandoned = yield* deployments.get({
            stack,
            stage,
            version: 1,
          });
          expect(abandoned?.outcome).toBe("abandoned");
          expect(abandoned?.endedAt).not.toBeUndefined();
        }),
    );

    it.effect(
      "end sets outcome/endedAt/summary; repeat end is a no-op preserving the first outcome",
      () =>
        Effect.gen(function* () {
          const { deployments } = yield* makeStore();
          const { stack, stage } = ids("end-idempotent");

          const { version, token } = yield* deployments.begin({
            stack,
            stage,
            meta: meta(),
          });

          yield* deployments.end({
            stack,
            stage,
            version,
            token,
            outcome: "failed",
            summary: { counts: { create: 1 }, error: "boom" },
          });

          const ended = yield* deployments.get({ stack, stage, version });
          expect(ended?.outcome).toBe("failed");
          expect(ended?.endedAt).not.toBeUndefined();
          expect(ended?.summary).toEqual({
            counts: { create: 1 },
            error: "boom",
          });

          // Repeat end (even with a different outcome/summary) is a no-op.
          yield* deployments.end({
            stack,
            stage,
            version,
            token,
            outcome: "succeeded",
            summary: { counts: { update: 9 } },
          });

          const after = yield* deployments.get({ stack, stage, version });
          expect(after?.outcome).toBe("failed");
          expect(after?.summary).toEqual({
            counts: { create: 1 },
            error: "boom",
          });
        }),
    );

    it.effect("end after abandonment records completed-late", () =>
      Effect.gen(function* () {
        const { deployments } = yield* makeStore();
        const { stack, stage } = ids("completed-late");

        const first = yield* deployments.begin({ stack, stage, meta: meta() });
        // Reconcile the first open to "abandoned".
        yield* deployments.begin({ stack, stage, meta: meta(), ttlMillis: 0 });

        yield* deployments.end({
          stack,
          stage,
          version: first.version,
          token: first.token,
          outcome: "succeeded",
        });

        const record = yield* deployments.get({
          stack,
          stage,
          version: first.version,
        });
        expect(record?.outcome).toBe("completed-late");
        expect(record?.endedAt).not.toBeUndefined();
      }),
    );

    it.effect(
      "appendEvents acks the highest stored seq; readEvents is seq-ascending with inclusive fromSeq",
      () =>
        Effect.gen(function* () {
          const { deployments } = yield* makeStore();
          const { stack, stage } = ids("append-read");

          const { version, token } = yield* deployments.begin({
            stack,
            stage,
            meta: meta(),
          });

          const { ackedSeq } = yield* deployments.appendEvents({
            stack,
            stage,
            version,
            token,
            events: [event(2), event(1), event(3)],
          });
          expect(ackedSeq).toBe(3);

          const all = yield* deployments.readEvents({ stack, stage, version });
          expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);

          const fromTwo = yield* deployments.readEvents({
            stack,
            stage,
            version,
            fromSeq: 2,
          });
          expect(fromTwo.map((e) => e.seq)).toEqual([2, 3]);
        }),
    );

    it.effect("retrying an overlapping batch does not duplicate events", () =>
      Effect.gen(function* () {
        const { deployments } = yield* makeStore();
        const { stack, stage } = ids("dedupe");

        const { version, token } = yield* deployments.begin({
          stack,
          stage,
          meta: meta(),
        });

        yield* deployments.appendEvents({
          stack,
          stage,
          version,
          token,
          events: [
            event(1, { first: true }),
            event(2, { first: true }),
            event(3, { first: true }),
          ],
        });

        // Crash-retry: the batch overlaps seqs 2 and 3, plus a new seq 4.
        const retried = yield* deployments.appendEvents({
          stack,
          stage,
          version,
          token,
          events: [
            event(2, { first: false }),
            event(3, { first: false }),
            event(4, { first: false }),
          ],
        });
        expect(retried.ackedSeq).toBe(4);

        const all = yield* deployments.readEvents({ stack, stage, version });
        expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
        // First write wins — the retried duplicates were ignored.
        expect(all[1]?.payload).toEqual({ first: true });
        expect(all[2]?.payload).toEqual({ first: true });
        expect(all[3]?.payload).toEqual({ first: false });
      }),
    );

    it.effect(
      "wrong token fails DeploymentTokenInvalid for append, heartbeat and end",
      () =>
        Effect.gen(function* () {
          const { deployments } = yield* makeStore();
          const { stack, stage } = ids("wrong-token");

          const { version } = yield* deployments.begin({
            stack,
            stage,
            meta: meta(),
          });
          const wrong = "not-the-token";

          const append = yield* Effect.result(
            deployments.appendEvents({
              stack,
              stage,
              version,
              token: wrong,
              events: [event(1)],
            }),
          );
          expect(Result.isFailure(append)).toBe(true);
          if (Result.isFailure(append)) {
            expect(append.failure._tag).toBe("DeploymentTokenInvalid");
          }

          const heartbeat = yield* Effect.result(
            deployments.heartbeat({ stack, stage, version, token: wrong }),
          );
          expect(Result.isFailure(heartbeat)).toBe(true);
          if (Result.isFailure(heartbeat)) {
            expect(heartbeat.failure._tag).toBe("DeploymentTokenInvalid");
          }

          const end = yield* Effect.result(
            deployments.end({
              stack,
              stage,
              version,
              token: wrong,
              outcome: "succeeded",
            }),
          );
          expect(Result.isFailure(end)).toBe(true);
          if (Result.isFailure(end)) {
            expect(end.failure._tag).toBe("DeploymentTokenInvalid");
          }
        }),
    );

    it.effect(
      "unknown version fails DeploymentNotFound for append, heartbeat, end and readEvents",
      () =>
        Effect.gen(function* () {
          const { deployments } = yield* makeStore();
          const { stack, stage } = ids("not-found");

          // Ensure the (stack, stage) exists but version 999 does not.
          const { token } = yield* deployments.begin({
            stack,
            stage,
            meta: meta(),
          });
          const version = 999;

          const append = yield* Effect.result(
            deployments.appendEvents({
              stack,
              stage,
              version,
              token,
              events: [event(1)],
            }),
          );
          expect(Result.isFailure(append)).toBe(true);
          if (Result.isFailure(append)) {
            expect(append.failure._tag).toBe("DeploymentNotFound");
          }

          const heartbeat = yield* Effect.result(
            deployments.heartbeat({ stack, stage, version, token }),
          );
          expect(Result.isFailure(heartbeat)).toBe(true);
          if (Result.isFailure(heartbeat)) {
            expect(heartbeat.failure._tag).toBe("DeploymentNotFound");
          }

          const end = yield* Effect.result(
            deployments.end({
              stack,
              stage,
              version,
              token,
              outcome: "succeeded",
            }),
          );
          expect(Result.isFailure(end)).toBe(true);
          if (Result.isFailure(end)) {
            expect(end.failure._tag).toBe("DeploymentNotFound");
          }

          const read = yield* Effect.result(
            deployments.readEvents({ stack, stage, version }),
          );
          expect(Result.isFailure(read)).toBe(true);
          if (Result.isFailure(read)) {
            expect(read.failure._tag).toBe("DeploymentNotFound");
          }
        }),
    );

    it.effect(
      "append after end is accepted with a matching token; heartbeat after end is a silent no-op",
      () =>
        Effect.gen(function* () {
          const { deployments } = yield* makeStore();
          const { stack, stage } = ids("after-end");

          const { version, token } = yield* deployments.begin({
            stack,
            stage,
            meta: meta(),
          });
          yield* deployments.appendEvents({
            stack,
            stage,
            version,
            token,
            events: [event(1)],
          });
          yield* deployments.end({
            stack,
            stage,
            version,
            token,
            outcome: "succeeded",
          });

          // Late flush after end: accepted, token still enforced.
          const late = yield* deployments.appendEvents({
            stack,
            stage,
            version,
            token,
            events: [event(2)],
          });
          expect(late.ackedSeq).toBe(2);
          const all = yield* deployments.readEvents({ stack, stage, version });
          expect(all.map((e) => e.seq)).toEqual([1, 2]);

          // Heartbeat after end: silent no-op, outcome untouched.
          yield* deployments.heartbeat({ stack, stage, version, token });
          const record = yield* deployments.get({ stack, stage, version });
          expect(record?.outcome).toBe("succeeded");
          expect(record?.endedAt).not.toBeUndefined();
        }),
    );

    it.effect("list is newest-first and honors before/limit", () =>
      Effect.gen(function* () {
        const { deployments } = yield* makeStore();
        const { stack, stage } = ids("list");

        for (let i = 0; i < 3; i++) {
          const { version, token } = yield* deployments.begin({
            stack,
            stage,
            meta: meta(),
          });
          yield* deployments.end({
            stack,
            stage,
            version,
            token,
            outcome: "succeeded",
          });
        }

        const all = yield* deployments.list({ stack, stage });
        expect(all.map((r) => r.version)).toEqual([3, 2, 1]);

        const limited = yield* deployments.list({ stack, stage, limit: 2 });
        expect(limited.map((r) => r.version)).toEqual([3, 2]);

        // `before` is a strictly-less-than cursor.
        const beforeThree = yield* deployments.list({
          stack,
          stage,
          before: 3,
        });
        expect(beforeThree.map((r) => r.version)).toEqual([2, 1]);

        const page = yield* deployments.list({
          stack,
          stage,
          before: 3,
          limit: 1,
        });
        expect(page.map((r) => r.version)).toEqual([2]);
      }),
    );

    it.effect("get of an unknown version returns undefined", () =>
      Effect.gen(function* () {
        const { deployments } = yield* makeStore();
        const { stack, stage } = ids("get-unknown");
        const record = yield* deployments.get({ stack, stage, version: 42 });
        expect(record).toBeUndefined();
      }),
    );

    it.effect(
      "returned records and events do not expose the token or alias internal state",
      () =>
        Effect.gen(function* () {
          const { deployments } = yield* makeStore();
          const { stack, stage } = ids("no-alias");

          const { version, token } = yield* deployments.begin({
            stack,
            stage,
            meta: meta("owner"),
          });
          yield* deployments.appendEvents({
            stack,
            stage,
            version,
            token,
            events: [event(1, { value: "original" })],
          });

          const record = yield* deployments.get({ stack, stage, version });
          expect(record).toBeDefined();
          expect("token" in record!).toBe(false);

          // Mutating the returned record must not leak into the store.
          record!.meta.initiator!.user = "intruder";
          (record as { outcome?: string }).outcome = "succeeded";
          const reread = yield* deployments.get({ stack, stage, version });
          expect(reread?.meta.initiator?.user).toBe("owner");
          expect(reread?.outcome).toBeUndefined();

          // Same for events.
          const events = yield* deployments.readEvents({
            stack,
            stage,
            version,
          });
          (events[0]!.payload as { value: string }).value = "mutated";
          const rereadEvents = yield* deployments.readEvents({
            stack,
            stage,
            version,
          });
          expect(rereadEvents[0]?.payload).toEqual({ value: "original" });

          // The listing view must not expose tokens either.
          const listed = yield* deployments.list({ stack, stage });
          expect("token" in listed[0]!).toBe(false);
        }),
    );

    it.effect("two concurrent begins produce exactly one success", () =>
      Effect.gen(function* () {
        const { deployments } = yield* makeStore();
        const { stack, stage } = ids("concurrent-begin");

        const results = yield* Effect.all(
          [
            Effect.result(
              deployments.begin({ stack, stage, meta: meta("racer-a") }),
            ),
            Effect.result(
              deployments.begin({ stack, stage, meta: meta("racer-b") }),
            ),
          ],
          { concurrency: "unbounded" },
        );

        const successes = results.filter(Result.isSuccess);
        const failures = results.filter(Result.isFailure);
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(successes[0]!.success.version).toBe(1);
        expect(failures[0]!.failure._tag).toBe("DeploymentInProgress");
      }),
    );

    (options.persistent ? it.effect : it.effect.skip)(
      "persists records and events across re-instantiation",
      () =>
        Effect.gen(function* () {
          const first = yield* makeStore();
          const { stack, stage } = ids("persistence");

          const { version, token } = yield* first.deployments.begin({
            stack,
            stage,
            meta: meta("persisted-user"),
          });
          yield* first.deployments.appendEvents({
            stack,
            stage,
            version,
            token,
            events: [event(1), event(2)],
          });
          yield* first.deployments.end({
            stack,
            stage,
            version,
            token,
            outcome: "succeeded",
            summary: { counts: { create: 2 } },
          });

          // A brand-new store over the same underlying storage sees it all.
          const second = yield* makeStore();
          const listed = yield* second.deployments.list({ stack, stage });
          expect(listed.map((r) => r.version)).toEqual([version]);

          const record = yield* second.deployments.get({
            stack,
            stage,
            version,
          });
          expect(record?.outcome).toBe("succeeded");
          expect(record?.meta.initiator?.user).toBe("persisted-user");
          expect(record?.summary).toEqual({ counts: { create: 2 } });

          const events = yield* second.deployments.readEvents({
            stack,
            stage,
            version,
          });
          expect(events.map((e) => e.seq)).toEqual([1, 2]);
        }),
    );

    it.effect("getAll returns every resource in the stage", () =>
      Effect.gen(function* () {
        const { state } = yield* makeStore();
        const { stack, stage } = ids("get-all");

        expect(state.getAll).toBeDefined();

        const a = resource("resource-a");
        const b = resource("resource-b");
        yield* state.set({ stack, stage, fqn: a.fqn, value: a });
        yield* state.set({ stack, stage, fqn: b.fqn, value: b });

        const all = yield* state.getAll!({ stack, stage });
        expect(all.size).toBe(2);
        expect(all.get("resource-a")).toEqual(a);
        expect(all.get("resource-b")).toEqual(b);

        const empty = yield* state.getAll!({
          stack,
          stage: `${stage}-empty`,
        });
        expect(empty.size).toBe(0);
      }),
    );
  });
};
