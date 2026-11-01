import type * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT PostgreSQL Flex suites.
 *
 * Instances are billed per started hour by flavor (about EUR 0.13 for `2.4`, plus
 * storage), so every suite that creates one is gated behind the provider-wide slow
 * flag `STACKIT_TEST_SLOW`. A full run holds about seven instances for an hour each.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/** The smallest single-node flavor the spec names. */
export const FLAVOR = "2.4";
export const VERSION = "17";

export const STORAGE_CLASS = "premium-perf2-stackit";
/** The next performance class up, for the replacement step. */
export const OTHER_STORAGE_CLASS = "premium-perf4-stackit";

/** Reserved documentation range: nothing can connect, which these suites don't need. */
export const CLOSED_ACL = "192.0.2.1/32";

export const instanceProps = (acl: string = CLOSED_ACL) =>
  ({
    flavorId: FLAVOR,
    version: VERSION,
    storage: { class: STORAGE_CLASS, size: 5 },
    backupSchedule: "0 2 * * *",
    retentionDays: 32,
    acl: [acl],
  }) satisfies Stackit.PostgresFlex.InstanceProps;

/** The instance, or `"gone"` on the typed `NotFound`. */
export const observeInstance = (projectId: string, region: string, instanceId: string) =>
  postgres
    .getInstance({ projectId, region, instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** The user, or `"gone"` on the typed `NotFound`. */
export const observeUser = (
  projectId: string,
  region: string,
  instanceId: string,
  userId: number,
) =>
  postgres
    .getUser({ projectId, region, instanceId, userId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** The database, or `"gone"` on the typed `NotFound`. */
export const observeDatabase = (
  projectId: string,
  region: string,
  instanceId: string,
  databaseId: number,
) =>
  postgres
    .getDatabase({ projectId, region, instanceId, databaseId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Bounded check that an observation reports `"gone"`. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 12,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );
