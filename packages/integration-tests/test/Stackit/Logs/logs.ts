import { expect } from "@alchemy.run/test";
import * as logs from "@distilled.cloud/stackit/logs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT Logs suites.
 *
 * Logs is pay-per-use (EUR 1.20 per GB ingested, EUR 0.01 per GB per retention day) with no
 * hourly instance fee in the price list, and a run ingests kilobytes: under EUR 0.01. So
 * the lifecycles run ungated.
 */

/** Reserved documentation range: nothing can connect, which the lifecycle suites don't need. */
export const CLOSED_ACL = "192.0.2.1/32";

/** The instance, or `"gone"` on the typed not-found or once it is deleting. */
export const observeInstance = (projectId: string, region: string, instanceId: string) =>
  logs.getLogsInstance({ projectId, regionId: region, instanceId }).pipe(
    Effect.map((instance) => (instance.status === "deleting" ? ("gone" as const) : instance)),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

export const observeToken = (projectId: string, region: string, instanceId: string, tId: string) =>
  logs
    .getAccessToken({ projectId, regionId: region, instanceId, tId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

export const observePolicy = (projectId: string, region: string, instanceId: string, pId: string) =>
  logs
    .getAccessPolicy({ projectId, regionId: region, instanceId, pId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Bounded wait (about 2 minutes) until a read reports `"gone"`, then assert it. */
export const expectGone = <A, E, R>(read: Effect.Effect<A | "gone", E, R>) =>
  read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (value) => value === "gone",
      times: 24,
    }),
    Effect.tap((value) => Effect.sync(() => expect(value).toEqual("gone"))),
  );
