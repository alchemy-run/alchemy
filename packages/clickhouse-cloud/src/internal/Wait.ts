import * as service from "@distilled.cloud/clickhouse-cloud/service";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { requireResult, ServiceFailed, ServiceNotReady } from "./Errors.ts";

export type ServiceState = service.ServiceState;

const RUNNING: Partial<Record<string, true>> = { running: true, idle: true };
const GONE: Partial<Record<string, true>> = {
  terminating: true,
  softdeleting: true,
  terminated: true,
  softdeleted: true,
};

/** A running service; `idle` is a running service scaled to zero by idle scaling. */
export const isRunning = (state: string | undefined) => RUNNING[state ?? ""] === true;
/** A service being deleted, or already deleted: it no longer exists for alchemy. */
export const isGone = (state: string | undefined) => GONE[state ?? ""] === true;

/**
 * Read a service; `undefined` when it is missing or being deleted. Only the
 * typed `NotFound` means missing: a permission error propagates.
 */
export const getLiveService = Effect.fn(function* (organizationId: string, serviceId: string) {
  const observed = yield* service.getService({ organizationId, serviceId }).pipe(
    Effect.flatMap(requireResult("getService")),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );
  if (observed === undefined || isGone(observed.state)) return undefined;
  return observed;
});

class StillWaiting extends Data.TaggedError("ClickHouseCloud.StillWaiting")<{
  readonly state: string | undefined;
}> {}

/**
 * How often a waiter reads the service. Each API key is limited to 10
 * requests per 10 seconds, and the rest of a deploy shares that budget.
 */
const POLL_INTERVAL = Duration.seconds(15);

/**
 * Poll `getService` until `done(service)` holds, and return the last
 * observation (`undefined` once the service is gone). A `failed` service
 * fails with {@link ServiceFailed}; a service still not done after `budget`
 * fails with {@link ServiceNotReady}. Creating or starting a service takes
 * minutes, so the default budget is 30 minutes.
 */
export const waitForService = Effect.fn(function* (input: {
  readonly organizationId: string;
  readonly serviceId: string;
  readonly waitingFor: string;
  readonly done: (observed: service.Service | undefined) => boolean;
  readonly session?: ScopedPlanStatusSession;
  readonly budget?: Duration.Input;
}) {
  const startedAt = yield* Clock.currentTimeMillis;
  const budget = Duration.fromInputUnsafe(input.budget ?? Duration.minutes(30));
  const times = Math.max(
    1,
    Math.ceil(Duration.toMillis(budget) / Duration.toMillis(POLL_INTERVAL)),
  );
  let lastState: string | undefined;
  return yield* Effect.gen(function* () {
    const observed = yield* getLiveService(input.organizationId, input.serviceId);
    lastState = observed?.state;
    if (observed?.state === "failed") {
      return yield* new ServiceFailed({ serviceId: input.serviceId, state: observed.state });
    }
    if (input.done(observed)) return observed;
    if (input.session) {
      const elapsed = Math.floor(((yield* Clock.currentTimeMillis) - startedAt) / 1000);
      yield* input.session.note(
        `Waiting for the service to be ${input.waitingFor} (state: ${lastState ?? "missing"}, ${elapsed}s elapsed)...`,
      );
    }
    return yield* new StillWaiting({ state: lastState });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ClickHouseCloud.StillWaiting",
      schedule: Schedule.spaced(POLL_INTERVAL),
      times,
    }),
    Effect.catchTag("ClickHouseCloud.StillWaiting", (e) =>
      Effect.fail(
        new ServiceNotReady({
          serviceId: input.serviceId,
          waitingFor: input.waitingFor,
          state: e.state,
        }),
      ),
    ),
  );
});
