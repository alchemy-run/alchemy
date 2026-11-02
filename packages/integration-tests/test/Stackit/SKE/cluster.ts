import { expect } from "@alchemy.run/test";
import * as ske from "@distilled.cloud/stackit/ske";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT SKE suites.
 *
 * A cluster takes 30-45 minutes up and about as long down, and bills per started
 * hour: EUR 0.0996 for the control plane plus EUR 0.0607 for a `c1.2` node, so
 * EUR 0.48 for a cluster that lives three hours (price list v1.0.44). Every
 * suite that creates one is gated behind the provider-wide slow flag, with wait
 * budgets to match the 45 and 90 minutes of STACKIT's Go SDK.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/** Test budget: a cluster up (45 minutes), down (90), and the steps between. */
export const CLUSTER_TEST_TIMEOUT = 3 * 60 * 60 * 1000;

export { smallPool } from "./pool.ts";

/** Out-of-band cluster state: the cluster, or "gone" on the typed `NotFound`. */
export const observeCluster = (projectId: string, region: string, clusterName: string) =>
  ske
    .getCluster({ projectId, region, clusterName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Assert the cluster is gone. `stack.destroy` waits, so this only absorbs a stale read. */
export const expectClusterGone = (projectId: string, region: string, clusterName: string) =>
  observeCluster(projectId, region, clusterName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (cluster) => cluster === "gone",
      times: 12,
    }),
    Effect.map((cluster) => expect(cluster).toEqual("gone")),
  );
