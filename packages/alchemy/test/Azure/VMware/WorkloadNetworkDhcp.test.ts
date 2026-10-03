import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as vmware from "@distilled.cloud/azure/vmware";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  AVS_TIMEOUT,
  logLevel,
  privateCloud,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { leaseTime: number }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const resource = yield* Azure.VMware.WorkloadNetworkDhcp("Dhcp", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      dhcpType: "SERVER",
      displayName: "alchemy-dhcp",
      serverAddress: "40.20.0.1/24",
      leaseTime: props.leaseTime,
    });

    return { group, cloud, resource };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete an NSX DHCP server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, resource } = yield* stack.deploy(
        program({ leaseTime: 86400 }),
      );
      const get = () =>
        vmware.GetWorkloadNetworkDhcp({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          dhcpId: resource.dhcpName,
        });
      const observed = yield* get();
      expect(observed.properties?.dhcpType).toEqual("SERVER");
      expect(observed.properties?.leaseTime).toEqual(86400);

      // In-place update.
      const updated = yield* stack.deploy(program({ leaseTime: 43200 }));
      expect(updated.resource.dhcpName).toEqual(resource.dhcpName);
      const reobserved = yield* get();
      expect(reobserved.properties?.leaseTime).toEqual(43200);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
