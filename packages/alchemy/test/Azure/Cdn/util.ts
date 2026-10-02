import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:cdn", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/**
 * Front Door Standard costs ~$35/month (~$0.05/hour) plus traffic; a run
 * stays well under $1, but Azure forbids Front Door profiles on the Free
 * Trial testing subscription (`FrontDoorFreeTrialForbidden`), so every
 * lifecycle needs `AZURE_TEST_PAID=1` on a Pay-As-You-Go subscription.
 * Profile deletes take 5-15 minutes.
 */
export const FRONT_DOOR_TIMEOUT = 900_000;

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

/** Resource group + Standard Front Door profile shared by child tests. */
export const profileStack = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const profile = yield* Azure.Cdn.Profile("FrontDoor", {
    resourceGroup: group.resourceGroupName,
  });
  return { group, profile };
});

/** Profile + origin group with one origin (needed before any route). */
export const originStack = Effect.gen(function* () {
  const { group, profile } = yield* profileStack;
  const originGroup = yield* Azure.Cdn.AfdOriginGroup("Origins", {
    resourceGroup: group.resourceGroupName,
    profile: profile.profileName,
    healthProbeSettings: {
      probePath: "/",
      probeProtocol: "Https",
      probeRequestType: "HEAD",
      probeIntervalInSeconds: 100,
    },
  });
  const origin = yield* Azure.Cdn.AfdOrigin("Origin", {
    resourceGroup: group.resourceGroupName,
    profile: profile.profileName,
    originGroup: originGroup.originGroupName,
    hostName: "www.bing.com",
  });
  return { group, profile, originGroup, origin };
});
