import { expect } from "@alchemy.run/test";
import * as edge from "@distilled.cloud/stackit/edge";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT Edge Cloud suites.
 *
 * `blocked: cost`. Edge Cloud is a private beta with no price in STACKIT's public price list
 * (v1.0.44, read 2026-11-01), so a run's cost is unknown. STACKIT's rule is per hour or part
 * thereof, so every instance costs at least one full hour of its plan. A full run creates nine
 * instances: six in the instance suite, one each in the kubeconfig, token and bindings suites.
 * No suite boots a host, which needs hardware.
 *
 * Every suite that creates an instance needs the provider-wide slow flag `STACKIT_TEST_SLOW`
 * and `STACKIT_TEST_EDGE`, which holds the id of a plan the project is entitled to: the
 * ungated probe in `Instance.test.ts` calls the operation that lists them.
 */
const PLAN_ID = process.env.STACKIT_TEST_EDGE;

export const slow = !process.env.STACKIT_TEST_SLOW || !PLAN_ID;

/** The plan the suites create instances on. */
export const planId = PLAN_ID ?? "";

/** A well-formed id no instance has: the API's ids are `<name>-<project hash>`. */
export const MISSING_INSTANCE_ID = "zzzz-0000000";

/** The instance, or `"gone"` on the typed not-found error. */
export const observeInstance = (projectId: string, region: string, instanceId: string) =>
  edge
    .getInstance({ projectId, regionId: region, instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Bounded check that an observation reports `"gone"`: every 5s for up to two minutes. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 24,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );
