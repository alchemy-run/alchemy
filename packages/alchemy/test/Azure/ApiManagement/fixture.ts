import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:apimanagement", "live"];

/**
 * Resource group + Consumption API Management service shared by the child
 * entity tests. Consumption has no idle cost and provisions in ~3 minutes.
 */
export const consumptionService = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const service = yield* Azure.ApiManagement.Service("Gateway", {
    resourceGroup: group.resourceGroupName,
    publisherEmail: "ops@example.com",
    publisherName: "Alchemy",
  });
  return { group, service };
});

/** Subscription id of the test environment. */
export const subscriptionId = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/**
 * Poll `get` until it fails with a typed not-found error. Bounded; returns
 * `"found"` if the entity is still there after the last poll.
 */
export const untilGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "NotFound", "ResourceGroupNotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

/**
 * Resource group + Developer-tier service for entities Consumption lacks
 * (groups, self-hosted gateways). Developer bills ~$0.07/h but provisions
 * in 30-45 minutes, so tests using it are gated behind `runExpensive`.
 */
export const developerService = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const service = yield* Azure.ApiManagement.Service("Developer", {
    resourceGroup: group.resourceGroupName,
    sku: { name: "Developer", capacity: 1 },
    publisherEmail: "ops@example.com",
    publisherName: "Alchemy",
  });
  return { group, service };
});
