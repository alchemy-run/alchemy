import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:containerregistry",
  "live",
];

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

export const getRegistry = (resourceGroupName: string, registryName: string) =>
  Effect.gen(function* () {
    return yield* containerregistry.GetRegistry({
      subscriptionId: yield* subscription,
      resourceGroupName,
      registryName,
    });
  });

/** Resource group + Basic registry shared by the child-resource tests. */
export const basicRegistry = (
  sku: Azure.ContainerRegistry.RegistrySku = "Basic",
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const registry = yield* Azure.ContainerRegistry.Registry("Registry", {
      resourceGroup: group.resourceGroupName,
      sku,
    });
    return { group, registry };
  });
