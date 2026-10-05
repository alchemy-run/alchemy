import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Out-of-band virtual network for the DNS resolver tests (the Network
 * service is not part of this namespace). Subnets listed in `subnets` are
 * delegated to `Microsoft.Network/dnsResolvers`.
 */
export const createVnet = (
  resourceGroupName: string,
  virtualNetworkName: string,
  addressPrefix: string,
  subnets: ReadonlyArray<{ name: string; addressPrefix: string }> = [],
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    yield* ensureRegistered(subscriptionId, "Microsoft.Network");
    yield* network.VirtualNetworksCreateOrUpdate({
      subscriptionId,
      resourceGroupName,
      virtualNetworkName,
      location: "eastus",
      properties: {
        addressSpace: { addressPrefixes: [addressPrefix] },
        subnets: subnets.map((subnet) => ({
          name: subnet.name,
          properties: {
            addressPrefix: subnet.addressPrefix,
            delegations: [
              {
                name: "dnsResolvers",
                properties: { serviceName: "Microsoft.Network/dnsResolvers" },
              },
            ],
          },
        })),
      },
    });
    const vnet = yield* network
      .GetVirtualNetwork({
        subscriptionId,
        resourceGroupName,
        virtualNetworkName,
      })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (vnet) => vnet.properties?.provisioningState === "Succeeded",
          times: 40,
        }),
      );
    expect(vnet.properties?.provisioningState).toEqual("Succeeded");
    const vnetId = vnet.id!;
    return {
      vnetId,
      subnetId: (name: string) => `${vnetId}/subnets/${name}`,
    };
  });

/** Delete the out-of-band virtual network and wait until it is gone. */
export const deleteVnet = (
  resourceGroupName: string,
  virtualNetworkName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const where = { subscriptionId, resourceGroupName, virtualNetworkName };
    yield* network
      .DeleteVirtualNetwork(where)
      .pipe(
        Effect.catchTag(
          ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
          () => Effect.void,
        ),
      );
    const status = yield* network.GetVirtualNetwork(where).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (status) => status === "gone",
        times: 40,
      }),
    );
    expect(status).toEqual("gone");
  });

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

/** The subscription ID of the ambient Azure environment. */
export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);
