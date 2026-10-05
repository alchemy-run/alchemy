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

const getVolume = (
  resourceGroupName: string,
  accountName: string,
  poolName: string,
  volumeName: string,
) =>
  Effect.gen(function* () {
    return yield* netapp.GetVolume({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      poolName,
      volumeName,
    });
  });

const program = (props: {
  sizeGiB: number;
  protocol: Azure.NetApp.NetAppProtocolType;
  allowedClients: string;
}) =>
  Effect.gen(function* () {
    const { group, account } = yield* accountBase;
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      addressPrefixes: ["10.20.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("AnfSubnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.20.1.0/24",
      delegations: [{ serviceName: "Microsoft.NetApp/volumes" }],
    });
    const pool = yield* Azure.NetApp.CapacityPool("Pool", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const volume = yield* Azure.NetApp.Volume("Data", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      pool: pool.poolName,
      subnetId: subnet.subnetId,
      usageThreshold: props.sizeGiB * Azure.NetApp.GiB,
      protocolTypes: [props.protocol],
      exportPolicy: [
        {
          ruleIndex: 1,
          allowedClients: props.allowedClients,
          unixReadOnly: false,
          unixReadWrite: true,
          nfsv3: props.protocol === "NFSv3",
          nfsv41: props.protocol === "NFSv4.1",
        },
      ],
    });
    return { group, account, pool, volume };
  });

// 1 TiB Standard pool (~$0.20/hour) for ~25 minutes (volume create/delete
// 3-6 minutes each): ~$0.20 per run. Free-trial subscriptions cannot create
// NetApp accounts (`NetAppCreationRestricted`, probed in Account.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, pool, volume } = yield* stack.deploy(
        program({
          sizeGiB: 100,
          protocol: "NFSv3",
          allowedClients: "0.0.0.0/0",
        }),
      );
      const get = (name: string) =>
        getVolume(
          group.resourceGroupName,
          account.accountName,
          pool.poolName,
          name,
        );
      expect(volume.mountIpAddresses.length).toBeGreaterThan(0);
      const observed = yield* get(volume.volumeName);
      expect(observed.properties.usageThreshold).toEqual(
        100 * Azure.NetApp.GiB,
      );
      expect(observed.properties.protocolTypes).toEqual(["NFSv3"]);
      expect(
        observed.properties.exportPolicy?.rules?.[0]?.allowedClients,
      ).toEqual("0.0.0.0/0");

      // In place: quota and export policy.
      const updated = yield* stack.deploy(
        program({
          sizeGiB: 200,
          protocol: "NFSv3",
          allowedClients: "10.20.0.0/16",
        }),
      );
      expect(updated.volume.volumeId).toEqual(volume.volumeId);
      const reobserved = yield* get(volume.volumeName);
      expect(reobserved.properties.usageThreshold).toEqual(
        200 * Azure.NetApp.GiB,
      );
      expect(
        reobserved.properties.exportPolicy?.rules?.[0]?.allowedClients,
      ).toEqual("10.20.0.0/16");

      // Replacement: protocol.
      const replaced = yield* stack.deploy(
        program({
          sizeGiB: 200,
          protocol: "NFSv4.1",
          allowedClients: "10.20.0.0/16",
        }),
      );
      expect(replaced.volume.volumeName).not.toEqual(volume.volumeName);
      expect(
        (yield* get(replaced.volume.volumeName)).properties.protocolTypes,
      ).toEqual(["NFSv4.1"]);
      expect(yield* waitGone(get(volume.volumeName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.volume.volumeName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
