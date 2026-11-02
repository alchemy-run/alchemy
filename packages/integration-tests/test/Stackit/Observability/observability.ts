import { expect } from "@alchemy.run/test";
import * as observability from "@distilled.cloud/stackit/observability";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT Observability suites.
 *
 * Instances are billed per started hour by plan, and take minutes to create, so every
 * suite is gated behind the provider-wide slow flag `STACKIT_TEST_SLOW`. Each file's
 * tests share one instance, except `AlertConfig.test.ts`, which has two. A full run creates
 * 20: `Observability-Monitoring-Starter` (EUR 0.0413 an hour) for 17 of them, and
 * `Observability-Starter` (EUR 0.0971 an hour) for `Instance.test.ts`, which also starts on
 * the Monitoring plan, for `LogsAlertGroup.test.ts` and for `Bindings.test.ts`. That is about
 * EUR 0.99 if every instance is gone within its first started hour, and about EUR 1.98 if
 * each runs into a second one. `STACKIT_TEST_OTHER_PROJECT` adds one more Monitoring instance,
 * in `AlertEventSource.test.ts`.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/** The cheapest plan with metrics. No logs and no traces. */
export const MONITORING_PLAN = "Observability-Monitoring-Starter-EU01";
/** The cheapest plan with logs and traces. */
export const STARTER_PLAN = "Observability-Starter-EU01";

/** An instance of the Instance API's response, or `"gone"` on the typed not-found or soft delete. */
export const observeInstance = (projectId: string, instanceId: string) =>
  observability.getInstance({ projectId, instanceId }).pipe(
    Effect.map((instance) =>
      instance.status === "DELETE_SUCCEEDED" ? ("gone" as const) : instance,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** Bounded check that an observation reports `"gone"`. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (state) => state === "gone",
      times: 30,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );
