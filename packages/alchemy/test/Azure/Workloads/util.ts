import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:workloads", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(
  get: Effect.Effect<A, AzureOpError, R>,
  times = 60,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times,
    }),
  );

/**
 * An AMS monitor in a VNet with a subnet delegated to
 * `Microsoft.Web/serverFarms` (the monitor's function app joins it).
 */
export const monitorStack = (props: {
  monitorTags?: Record<string, string>;
  routingPreference?: "Default" | "RouteAll";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      addressPrefixes: ["10.20.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Ams", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.20.1.0/24",
      delegations: [{ serviceName: "Microsoft.Web/serverFarms" }],
    });
    const monitor = yield* Azure.Workloads.Monitor("Ams", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      monitorSubnet: subnet.subnetId,
      routingPreference: props.routingPreference,
      tags: props.monitorTags,
    });
    return { group, vnet, subnet, monitor };
  });
