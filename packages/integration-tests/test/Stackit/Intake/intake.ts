import { expect } from "@alchemy.run/test";
import * as intake from "@distilled.cloud/stackit/intake";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT Intake suites.
 *
 * A runner bills its reserved capacity per hour while it exists: EUR 0.0417 per GB/h, for
 * every hour or part of one. Every suite that creates one is gated behind the provider-wide
 * slow flag `STACKIT_TEST_SLOW`. A full run creates eight runners: Runner.test.ts three (one
 * raised to about 2 GiB/h), Intake.test.ts two, User.test.ts one, Bindings.test.ts one and
 * Kafka.test.ts one. That is about 9.6 GB/h for one hour, so about EUR 0.40, and more if a
 * suite spans an hour boundary. Without Dremio, nothing here pays for the flush.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

export { CAPACITY, CATALOG, PASSWORD } from "./fixtures/constants.ts";

/** The runner, or `"gone"` on the typed `NotFound`. */
export const observeRunner = (projectId: string, regionId: string, intakeRunnerId: string) =>
  intake
    .getIntakeRunner({ projectId, regionId, intakeRunnerId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** The intake, or `"gone"` on the typed `NotFound`. */
export const observeIntake = (projectId: string, regionId: string, intakeId: string) =>
  intake
    .getIntake({ projectId, regionId, intakeId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** The user, or `"gone"` on the typed `NotFound`. */
export const observeUser = (
  projectId: string,
  regionId: string,
  intakeId: string,
  intakeUserId: string,
) =>
  intake
    .getIntakeUser({ projectId, regionId, intakeId, intakeUserId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Bounded check that an observation reports `"gone"`. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 24,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );
