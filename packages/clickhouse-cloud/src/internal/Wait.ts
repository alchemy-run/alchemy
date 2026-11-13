import * as service from "@distilled.cloud/clickhouse-cloud/service";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { OperationFailed, OperationTimedOut, ServiceFailed, ServiceNotReady } from "../Errors.ts";

const RUNNING: Partial<Record<service.ServiceState, true>> = { running: true, idle: true };
const GONE: Partial<Record<service.ServiceState, true>> = {
  terminating: true,
  softdeleting: true,
  terminated: true,
  softdeleted: true,
};

/** A running service; `idle` is a running service scaled to zero by idle scaling. */
export const isRunning = (state: service.ServiceState | undefined) =>
  state !== undefined && RUNNING[state] === true;
/** A service being deleted, or already deleted: it no longer exists for alchemy. */
export const isGone = (state: service.ServiceState | undefined) =>
  state !== undefined && GONE[state] === true;

/**
 * Read a service; `undefined` when it is missing or being deleted. Only the
 * typed `NotFound` means missing: a permission error propagates.
 */
export const getLiveService = Effect.fn(function* (organizationId: string, serviceId: string) {
  const observed = yield* service
    .getService({ organizationId, serviceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  if (observed === undefined || isGone(observed.state)) return undefined;
  return observed;
});

/**
 * How often a waiter reads. Each API key is limited to 10 requests per 10
 * seconds, and the rest of a deploy shares that budget.
 */
const POLL_INTERVAL = Duration.seconds(15);

/**
 * Poll `read` until `done` holds and return that observation, narrowed by
 * `done`. `failed` (a reason, or `undefined` to keep waiting) fails with
 * {@link OperationFailed}; not done within `budget` fails with
 * {@link OperationTimedOut}. Each wait is reported through `session`.
 */
export const pollUntil = <A, B extends A, E, R>(input: {
  readonly kind: string;
  readonly id: string;
  readonly waitingFor: string;
  readonly read: Effect.Effect<A, E, R>;
  readonly state: (observed: A) => string | undefined;
  readonly done: (observed: A) => observed is B;
  readonly failed?: (observed: A) => string | undefined;
  readonly session?: ScopedPlanStatusSession;
  readonly budget?: Duration.Input;
  readonly interval?: Duration.Input;
}): Effect.Effect<B, E | OperationFailed | OperationTimedOut, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const budget = Duration.fromInputUnsafe(input.budget ?? Duration.minutes(30));
    const interval = Duration.fromInputUnsafe(input.interval ?? POLL_INTERVAL);
    const observe = Effect.gen(function* () {
      const observed = yield* input.read;
      const failure = input.failed?.(observed);
      if (failure !== undefined) {
        return yield* new OperationFailed({
          kind: input.kind,
          id: input.id,
          state: input.state(observed) ?? "unknown",
          detail: failure,
        });
      }
      if (!input.done(observed) && input.session) {
        const elapsed = Math.floor(((yield* Clock.currentTimeMillis) - startedAt) / 1000);
        yield* input.session.note(
          `Waiting for the ${input.kind} to be ${input.waitingFor} (state: ${input.state(observed) ?? "missing"}, ${elapsed}s elapsed)...`,
        );
      }
      return observed;
    });
    const last = yield* observe.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(interval).pipe(Schedule.upTo({ duration: budget })),
        until: input.done,
      }),
    );
    if (input.done(last)) return last;
    return yield* new OperationTimedOut({
      kind: input.kind,
      id: input.id,
      waitingFor: input.waitingFor,
      state: input.state(last),
    });
  });

/**
 * Wait until a service satisfies `done`; a `failed` service fails with
 * {@link ServiceFailed}, one that disappears or stays unsettled for
 * `budget` (30 minutes by default: creating or starting takes minutes)
 * with {@link ServiceNotReady}.
 */
export const waitForService = Effect.fn(function* (input: {
  readonly organizationId: string;
  readonly serviceId: string;
  readonly waitingFor: string;
  readonly done: (observed: service.Service) => boolean;
  readonly session?: ScopedPlanStatusSession;
  readonly budget?: Duration.Input;
}) {
  return yield* pollUntil({
    kind: "service",
    id: input.serviceId,
    waitingFor: input.waitingFor,
    read: getLiveService(input.organizationId, input.serviceId),
    state: (s) => s?.state ?? "deleted",
    done: (s): s is service.Service => s !== undefined && input.done(s),
    failed: (s) => (s === undefined ? "deleted" : s.state === "failed" ? "failed" : undefined),
    session: input.session,
    budget: input.budget,
  }).pipe(
    Effect.catchTags({
      "ClickHouseCloud.OperationFailed": (e) =>
        e.state === "failed"
          ? Effect.fail(new ServiceFailed({ serviceId: input.serviceId, state: e.state }))
          : Effect.fail(
              new ServiceNotReady({
                serviceId: input.serviceId,
                waitingFor: input.waitingFor,
                state: e.state,
              }),
            ),
      "ClickHouseCloud.OperationTimedOut": (e) =>
        Effect.fail(
          new ServiceNotReady({
            serviceId: input.serviceId,
            waitingFor: input.waitingFor,
            state: e.state,
          }),
        ),
    }),
  );
});

/** Wait until a service is gone (missing, or terminating/terminated). */
export const waitUntilServiceGone = Effect.fn(function* (input: {
  readonly organizationId: string;
  readonly serviceId: string;
  readonly session?: ScopedPlanStatusSession;
}) {
  yield* pollUntil({
    kind: "service",
    id: input.serviceId,
    waitingFor: "deleted",
    read: getLiveService(input.organizationId, input.serviceId),
    state: (s) => s?.state,
    done: (s): s is undefined => s === undefined,
    session: input.session,
  });
});

/**
 * Make sure a service is `running`: an idle service is woken with the
 * `awake` command, a service on its way to running is waited for. Some
 * operations (attaching a UDF) are refused unless the service runs. A
 * stopped or missing service is returned as is: starting one is the
 * `Service` resource's decision.
 */
export const ensureAwake = Effect.fn(function* (input: {
  readonly organizationId: string;
  readonly serviceId: string;
  readonly session?: ScopedPlanStatusSession;
}) {
  const observed = yield* getLiveService(input.organizationId, input.serviceId);
  if (observed === undefined || observed.state === "running" || observed.state === "stopped") {
    return observed;
  }
  if (observed.state === "idle") {
    if (input.session) yield* input.session.note("Waking the idle service...");
    // Already waking (no longer idle): wait for it like any other.
    yield* service
      .updateServiceState({
        organizationId: input.organizationId,
        serviceId: input.serviceId,
        command: "awake",
      })
      .pipe(Effect.catchTag("ServiceNotIdle", () => Effect.void));
  }
  return yield* waitForService({
    organizationId: input.organizationId,
    serviceId: input.serviceId,
    waitingFor: "running",
    done: (s) => s.state === "running",
    session: input.session,
    budget: Duration.minutes(10),
  });
});
