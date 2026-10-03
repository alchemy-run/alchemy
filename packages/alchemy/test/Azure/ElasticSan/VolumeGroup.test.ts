import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as elasticsan from "@distilled.cloud/azure/elasticsan";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (
  resourceGroupName: string,
  elasticSanName: string,
  volumeGroupName: string,
) =>
  Effect.gen(function* () {
    return yield* elasticsan.GetVolumeGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      elasticSanName,
      volumeGroupName,
    });
  });

const program = (props: {
  name?: string;
  allowSubnet?: boolean;
  enforceDataIntegrityCheckForIscsi?: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.42.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Subnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.42.1.0/24",
      serviceEndpoints: [{ service: "Microsoft.Storage" }],
    });
    const san = yield* Azure.ElasticSan.ElasticSan("San", {
      resourceGroup: group.resourceGroupName,
    });
    const volumeGroup = yield* Azure.ElasticSan.VolumeGroup("Volumes", {
      resourceGroup: group.resourceGroupName,
      elasticSan: san.elasticSanName,
      name: props.name,
      virtualNetworkRules: props.allowSubnet ? [{ id: subnet.subnetId }] : [],
      enforceDataIntegrityCheckForIscsi:
        props.enforceDataIntegrityCheckForIscsi,
    });
    return { group, san, subnet, volumeGroup };
  });

// One 1 TiB Elastic SAN (~$0.13/hour) plus a free VNet: ~$0.05 per run,
// ~5 minutes.
test.provider(
  "create, update, replace, and delete an elastic san volume group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({}));
      const rg = created.group.resourceGroupName;
      const sanName = created.san.elasticSanName;
      const first = created.volumeGroup;
      expect(first.protocolType.toLowerCase()).toEqual("iscsi");
      expect(first.encryption).toEqual("EncryptionAtRestWithPlatformKey");
      expect(first.virtualNetworkRules).toEqual([]);
      const observed = yield* getGroup(rg, sanName, first.volumeGroupName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // In-place update: allow the subnet and enforce CRC checks.
      const updated = yield* stack.deploy(
        program({ allowSubnet: true, enforceDataIntegrityCheckForIscsi: true }),
      );
      expect(updated.volumeGroup.volumeGroupId).toEqual(first.volumeGroupId);
      const reobserved = yield* getGroup(rg, sanName, first.volumeGroupName);
      expect(
        (reobserved.properties?.networkAcls?.virtualNetworkRules ?? []).map(
          (rule) => rule.id.toLowerCase(),
        ),
      ).toEqual([updated.subnet.subnetId.toLowerCase()]);
      expect(reobserved.properties?.enforceDataIntegrityCheckForIscsi).toEqual(
        true,
      );

      // Renaming replaces the volume group.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-vg-renamed", allowSubnet: true }),
      );
      expect(renamed.volumeGroup.volumeGroupName).toEqual("alchemy-vg-renamed");
      yield* getGroup(rg, sanName, "alchemy-vg-renamed");
      expect(
        yield* waitGone(getGroup(rg, sanName, first.volumeGroupName)),
      ).toEqual("gone");

      // Removing the subnet rule converges back to no rules.
      const cleared = yield* stack.deploy(
        program({ name: "alchemy-vg-renamed" }),
      );
      expect(cleared.volumeGroup.virtualNetworkRules).toEqual([]);

      yield* stack.destroy();
      expect(
        yield* waitGone(getGroup(rg, sanName, "alchemy-vg-renamed")),
      ).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
