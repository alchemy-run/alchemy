import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:domainservices", "live"];

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
      schedule: Schedule.spaced("30 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

/** VNet + dedicated subnet with the NSG rule Entra DS needs for management. */
export const network = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const nsg = yield* Azure.Network.NetworkSecurityGroup("Nsg", {
    resourceGroup: group.resourceGroupName,
  });
  yield* Azure.Network.SecurityRule("AllowPSRemoting", {
    resourceGroup: group.resourceGroupName,
    networkSecurityGroup: nsg.networkSecurityGroupName,
    priority: 301,
    direction: "Inbound",
    access: "Allow",
    protocol: "Tcp",
    sourcePortRange: "*",
    destinationPortRange: "5986",
    sourceAddressPrefix: "AzureActiveDirectoryDomainServices",
    destinationAddressPrefix: "*",
  });
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    addressPrefixes: ["10.40.0.0/16"],
  });
  const subnet = yield* Azure.Network.Subnet("Subnet", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.40.0.0/24",
    networkSecurityGroupId: nsg.networkSecurityGroupId,
  });
  return { group, subnet };
});
