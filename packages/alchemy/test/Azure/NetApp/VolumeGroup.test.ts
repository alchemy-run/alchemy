import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/azure/netapp";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  accountBase,
  LOCATION,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { description: string }) =>
  Effect.gen(function* () {
    const { group, account } = yield* accountBase;
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      addressPrefixes: ["10.22.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("AnfSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.22.1.0/24",
      delegations: [{ serviceName: "Microsoft.NetApp/volumes" }],
    });
    // Application volume groups need a manual-QoS pool.
    const pool = yield* Azure.NetApp.CapacityPool("Pool", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      serviceLevel: "Premium",
      qosType: "Manual",
    });
    const volumeGroup = yield* Azure.NetApp.VolumeGroup("Ora", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      applicationType: "ORACLE",
      applicationIdentifier: "OR1",
      groupDescription: props.description,
      volumes: [
        {
          name: "OR1-ora-data1",
          volumeSpecName: "ora-data1",
          capacityPoolResourceId: pool.capacityPoolId,
          subnetId: subnet.subnetId,
          throughputMibps: 32,
          zones: ["1"],
        },
        {
          name: "OR1-ora-log",
          volumeSpecName: "ora-log",
          capacityPoolResourceId: pool.capacityPoolId,
          subnetId: subnet.subnetId,
          throughputMibps: 32,
          zones: ["1"],
        },
      ],
    });
    return { group, account, pool, volumeGroup };
  });

// 1 TiB Premium manual-QoS pool (~$0.40/hour) for ~40 minutes (two
// volumes, replaced once): ~$0.40 per run. Free-trial subscriptions cannot
// create NetApp accounts (`NetAppCreationRestricted`, probed in
// Account.test.ts); application volume groups are also region-gated.
test.provider.skipIf(!runPaidOnly)(
  "create, replace, and delete an oracle application volume group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, volumeGroup } = yield* stack.deploy(
        program({ description: "first" }),
      );
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* netapp.GetVolumeGroup({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
            volumeGroupName: name,
          });
        });
      expect(volumeGroup.volumeIds).toHaveLength(2);
      const observed = yield* get(volumeGroup.volumeGroupName);
      expect(observed.properties?.groupMetaData?.applicationType).toEqual(
        "ORACLE",
      );

      // Replacement: every property is create-only.
      const replaced = yield* stack.deploy(program({ description: "second" }));
      expect(replaced.volumeGroup.volumeGroupName).not.toEqual(
        volumeGroup.volumeGroupName,
      );
      expect(yield* waitGone(get(volumeGroup.volumeGroupName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.volumeGroup.volumeGroupName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
