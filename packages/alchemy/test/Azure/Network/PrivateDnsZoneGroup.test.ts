import * as Azure from "@/Azure";
import { orUndefinedIfNotFound, waitForProvisioned } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import * as privatedns from "@distilled.cloud/azure/privatedns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const ZONE = "privatelink.blob.core.windows.net";

const getGroup = (
  resourceGroupName: string,
  privateEndpointName: string,
  privateDnsZoneGroupName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetPrivateDnsZoneGroup({
      subscriptionId,
      resourceGroupName,
      privateEndpointName,
      privateDnsZoneGroupName,
    }),
  );

const getZone = (resourceGroupName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    privatedns.GetPrivateZone({
      subscriptionId,
      resourceGroupName,
      privateZoneName: ZONE,
    }),
  );

// Azure.PrivateDns is not implemented yet: the zone is created out-of-band
// inside the stack's resource group.
const createZone = (resourceGroupName: string) =>
  Effect.gen(function* () {
    yield* privatedns.PrivateZonesCreateOrUpdate({
      subscriptionId: yield* subscriptionId,
      resourceGroupName,
      privateZoneName: ZONE,
      location: "global",
    });
    return yield* waitForProvisioned(
      `private DNS zone ${ZONE}`,
      orUndefinedIfNotFound(getZone(resourceGroupName)),
      (zone) => zone.properties?.provisioningState,
      { interval: "5 seconds", times: 60 },
    );
  });

const deleteZone = (resourceGroupName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    orUndefinedIfNotFound(
      privatedns.DeletePrivateZone({
        subscriptionId,
        resourceGroupName,
        privateZoneName: ZONE,
      }),
    ),
  );

// Private endpoint ~$0.01/hour, private DNS zone $0.50/month prorated, and
// an empty Standard_LRS storage account; a few minutes cost well under $0.01.
const program = (props: { zoneId?: string; configName?: string }) =>
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
    });
    const zoneGroup =
      props.zoneId === undefined
        ? undefined
        : yield* Azure.Network.PrivateDnsZoneGroup("FilesBlobDns", {
            resourceGroup: group.resourceGroupName,
            privateEndpoint: endpoint.privateEndpointName,
            privateDnsZoneConfigs: [
              { name: props.configName, privateDnsZoneId: props.zoneId },
            ],
          });
    return { group, account, endpoint, zoneGroup };
  });

test.provider(
  "create, update, and delete a private DNS zone group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Step 1: the endpoint, then the zone out-of-band in its group.
      const { group } = yield* stack.deploy(program({}));
      const zone = yield* createZone(group.resourceGroupName);
      const zoneId = zone.id!;

      // Step 2: the zone group registers the endpoint's A record.
      const { account, endpoint, zoneGroup } = yield* stack.deploy(
        program({ zoneId }),
      );
      expect(zoneGroup).toBeDefined();
      expect(zoneGroup!.privateDnsZoneIds.map((z) => z.toLowerCase())).toEqual([
        zoneId.toLowerCase(),
      ]);
      const observed = yield* getGroup(
        group.resourceGroupName,
        endpoint.privateEndpointName,
        zoneGroup!.privateDnsZoneGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      const configs = observed.properties?.privateDnsZoneConfigs ?? [];
      expect(configs.map((c) => c.name)).toEqual([
        "privatelink-blob-core-windows-net",
      ]);
      const records = configs[0]?.properties?.recordSets ?? [];
      expect(records.map((r) => r.recordSetName)).toContain(
        account.storageAccountName,
      );
      expect(records[0]?.ipAddresses?.[0]).toMatch(/^10\.0\.1\.\d+$/);

      // Step 3: rename the zone configuration in place.
      const updated = yield* stack.deploy(
        program({ zoneId, configName: "blob" }),
      );
      expect(updated.zoneGroup!.privateDnsZoneGroupId).toEqual(
        zoneGroup!.privateDnsZoneGroupId,
      );
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        endpoint.privateEndpointName,
        zoneGroup!.privateDnsZoneGroupName,
      );
      expect(
        (reobserved.properties?.privateDnsZoneConfigs ?? []).map((c) => c.name),
      ).toEqual(["blob"]);

      // Step 4: drop the zone group while keeping the endpoint.
      yield* stack.deploy(program({}));
      expect(
        yield* untilGone(
          getGroup(
            group.resourceGroupName,
            endpoint.privateEndpointName,
            zoneGroup!.privateDnsZoneGroupName,
          ),
        ),
      ).toEqual("gone");

      yield* deleteZone(group.resourceGroupName);
      yield* stack.destroy();
      expect(yield* untilGone(getZone(group.resourceGroupName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
