import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:vmware", "live"];

/**
 * An AVS private cloud provisions dedicated hosts for 3-4 hours (and
 * deletes for another 1-2), far beyond the usual 15-minute test budget.
 * Only the `AZURE_TEST_PAID=1` lifecycles use this.
 */
export const AVS_TIMEOUT = 6 * 60 * 60 * 1000;

/**
 * Cost of every AVS lifecycle: a 3-host AV36P private cloud is billed
 * ~$30/hour and needs ~4-6 hours from create to delete (~$150-200 per run),
 * plus an AVS host quota that free-trial subscriptions cannot get
 * (`QuotaExceeded`).
 */
export const AVS_COST_USD = 180;

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/** A resource group plus the smallest private cloud (3 x AV36P). */
export const privateCloud = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const cloud = yield* Azure.VMware.PrivateCloud("Cloud", {
    resourceGroup: group.resourceGroupName,
    sku: "av36p",
    networkBlock: "10.175.0.0/22",
    clusterSize: 3,
  });
  return { group, cloud };
});
