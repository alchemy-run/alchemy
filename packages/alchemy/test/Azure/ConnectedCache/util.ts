import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as connectedcache from "@distilled.cloud/azure/connectedcache";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:connectedcache", "live"];

/** The subscription ID of the ambient Azure environment. */
export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/**
 * Repeat a typed GET until it reports the resource as gone. Only typed
 * not-found tags count as gone.
 */
export const untilGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
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

export const getCustomer = (
  resourceGroupName: string,
  customerResourceName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    connectedcache.GetEnterpriseMccCustomer({
      subscriptionId,
      resourceGroupName,
      customerResourceName,
    }),
  );

export const getCacheNode = (
  resourceGroupName: string,
  customerResourceName: string,
  cacheNodeResourceName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    connectedcache.GetEnterpriseMccCacheNodesOperation({
      subscriptionId,
      resourceGroupName,
      customerResourceName,
      cacheNodeResourceName,
    }),
  );

/**
 * Poll a typed GET until `provisioningState` reports `Succeeded` (the RP's
 * replicas can briefly serve `Accepted` after a write).
 */
export const untilSucceeded = <
  A extends { properties?: { provisioningState?: string } },
  E,
  R,
>(
  get: Effect.Effect<A, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (value) => value.properties?.provisioningState === "Succeeded",
      times: 24,
    }),
  );
