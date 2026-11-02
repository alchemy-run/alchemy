import type * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT SQL Server Flex suites.
 *
 * The most expensive suites of the provider: an instance is billed per started hour
 * by flavor, plus storage and the SQL Server licence. The cheapest SKU on STACKIT's
 * product page is EUR 7.08 per hour, and each created instance costs at least one
 * full hour. So they are gated behind `STACKIT_TEST_SQLSERVER` as well as the
 * provider-wide `STACKIT_TEST_SLOW`, and each file creates one instance, plus one for
 * the replacement step of `Instance.test.ts`: five for all of them, and one to run a
 * single file. Check `listFlavors` and the price list before a run.
 */
export const gated = !process.env.STACKIT_TEST_SLOW || !process.env.STACKIT_TEST_SQLSERVER;

/** The single-node flavor in the Terraform provider's example. */
export const FLAVOR = "4.16-Single";
export const VERSION = "2022";

export const STORAGE_CLASS = "premium-perf2-stackit";
/** The next performance class up, for the replacement step. */
export const OTHER_STORAGE_CLASS = "premium-perf4-stackit";

/** Reserved documentation range: nothing can connect, which these suites don't need. */
export const CLOSED_ACL = "192.0.2.1/32";

/** What a user needs to log in and own a database. */
export const ROLES = ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"];

export const instanceProps = (acl: string = CLOSED_ACL) =>
  ({
    flavorId: FLAVOR,
    version: VERSION,
    storage: { class: STORAGE_CLASS, size: 5 },
    backupSchedule: "0 2 * * *",
    retentionDays: 32,
    acl: [acl],
  }) satisfies Stackit.SQLServerFlex.InstanceProps;

/** The instance, or `"gone"` on the typed `NotFound`. */
export const observeInstance = (projectId: string, region: string, instanceId: string) =>
  sqlserver
    .getInstance({ projectId, region, instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** The user, or `"gone"` on the typed `NotFound`. */
export const observeUser = (
  projectId: string,
  region: string,
  instanceId: string,
  userId: number,
) =>
  sqlserver
    .getUser({ projectId, region, instanceId, userId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** The database, or `"gone"` on the typed `NotFound`. */
export const observeDatabase = (
  projectId: string,
  region: string,
  instanceId: string,
  databaseName: string,
) =>
  sqlserver
    .getDatabase({ projectId, region, instanceId, databaseName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Bounded check that an observation reports `"gone"`. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 36,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );
