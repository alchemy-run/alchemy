import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEndpoint = (resourceGroupName: string, privateEndpointName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetPrivateEndpoint({
      subscriptionId,
      resourceGroupName,
      privateEndpointName,
    }),
  );

// Private endpoint ~$0.01/hour + an empty Standard_LRS storage account;
// the test runs for a few minutes (well under $0.01).
const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Endpoints", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const endpoint = yield* Azure.Network.PrivateEndpoint("FilesBlob", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      privateLinkServiceConnections: [
        { privateLinkServiceId: account.storageAccountId, groupIds: ["blob"] },
      ],
      tags: props.tags,
    });
    return { group, account, subnet, endpoint };
  });

test.provider(
  "create, update, and delete a private endpoint to blob storage",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, subnet, endpoint } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(endpoint.connectionStatus).toEqual("Approved");
      expect(endpoint.subnetId.toLowerCase()).toEqual(
        subnet.subnetId.toLowerCase(),
      );
      expect(endpoint.networkInterfaceIds.length).toEqual(1);
      expect(endpoint.customDnsConfigs.map((c) => c.fqdn)).toContain(
        `${account.storageAccountName}.blob.core.windows.net`,
      );
      expect(endpoint.customDnsConfigs[0]?.ipAddresses[0]).toMatch(
        /^10\.0\.1\.\d+$/,
      );
      const observed = yield* getEndpoint(
        group.resourceGroupName,
        endpoint.privateEndpointName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.privateLinkServiceConnections?.[0]?.properties
          ?.groupIds,
      ).toEqual(["blob"]);
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.endpoint.privateEndpointId).toEqual(
        endpoint.privateEndpointId,
      );
      const reobserved = yield* getEndpoint(
        group.resourceGroupName,
        endpoint.privateEndpointName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(
        reobserved.properties?.networkInterfaces?.[0]?.id?.toLowerCase(),
      ).toEqual(endpoint.networkInterfaceIds[0]?.toLowerCase());

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getEndpoint(group.resourceGroupName, endpoint.privateEndpointName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
