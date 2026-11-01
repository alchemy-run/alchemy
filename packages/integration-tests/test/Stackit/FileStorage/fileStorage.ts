import type * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT File Storage suites.
 *
 * A resource pool has a 500 GB minimum and is billed per started hour: about EUR 0.16 at
 * the `Standard` rate, if the published price is per GB, as partner pages say. So every
 * suite that creates one is gated behind the provider-wide slow flag `STACKIT_TEST_SLOW`.
 *
 * A full run creates five pools: two in `ResourcePool.test.ts` (the rename step replaces
 * one), and one each in `Share.test.ts`, `ResourcePoolSnapshot.test.ts` and
 * `Bindings.test.ts`. If each stays under an hour that is about EUR 0.80, plus a started
 * hour of one `g1.1` server with a 10 GB volume (under EUR 0.05) for `MountShare`. A pool
 * taking its full 30-minute budget to create and to delete can bill a second hour, so a
 * slow run costs up to about EUR 1.60.
 *
 * `ShareExportPolicy.test.ts` and `ProjectLock.test.ts` create nothing billable and run
 * ungated.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

export class NoPerformanceClass extends Data.TaggedError("NoPerformanceClass")<{
  readonly message: string;
}> {}

/** The name of the performance class with the lowest IOPS, which is the cheapest. */
export const cheapestPerformanceClass = Effect.gen(function* () {
  const { performanceClasses } = yield* sfs.listPerformanceClasses({});
  const sorted = [...(performanceClasses ?? [])].sort((a, b) => (a.iops ?? 0) - (b.iops ?? 0));
  const name = sorted[0]?.name;
  if (name === undefined) {
    return yield* new NoPerformanceClass({ message: "STACKIT lists no performance classes" });
  }
  return name;
});

/** Documentation range: nothing mounts anything, which most suites don't need. */
export const CLOSED_ACL = "192.0.2.0/24";

/** The smallest pool STACKIT allows. */
export const MIN_SIZE = 500;

/** Props of the smallest pool, in the region's first zone. */
export const poolProps = (region: string, performanceClass: string) =>
  ({
    availabilityZone: `${region}-1`,
    performanceClass,
    sizeGigabytes: MIN_SIZE,
    ipAcl: [CLOSED_ACL],
  }) satisfies Stackit.FileStorage.ResourcePoolProps;

/** The pool, or `"gone"` on a typed answer that it is missing. */
export const observePool = (projectId: string, region: string, resourcePoolId: string) =>
  sfs.getResourcePool({ projectId, region, resourcePoolId }).pipe(
    Effect.map(({ resourcePool }) => resourcePool),
    Effect.catchTag(["NotFound", "Gone"], () => Effect.succeed("gone" as const)),
  );

/** The share, or `"gone"` on the typed `NotFound`. */
export const observeShare = (
  projectId: string,
  region: string,
  resourcePoolId: string,
  shareId: string,
) =>
  sfs.getShare({ projectId, region, resourcePoolId, shareId }).pipe(
    Effect.map(({ share }) => share),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** The policy, or `"gone"` on the typed `NotFound`. */
export const observePolicy = (projectId: string, region: string, policyId: string) =>
  sfs.getShareExportPolicy({ projectId, region, policyId }).pipe(
    Effect.map(({ shareExportPolicy }) => shareExportPolicy),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

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
