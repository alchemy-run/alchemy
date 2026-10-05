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

const program = (props: { numberOfPublicIPs: number }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const resource = yield* Azure.VMware.WorkloadNetworkPublicIP("Edge", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      numberOfPublicIPs: props.numberOfPublicIPs,
    });
    return { group, cloud, resource };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
// Skipped: failed in the last live run. QuotaExceeded: Allocation failed. You do not have
// sufficient capacity for the requested Private Cloud size in this region.
test.provider.skip(
  "create, replace, and delete an NSX public IP block",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, resource } = yield* stack.deploy(
        program({ numberOfPublicIPs: 1 }),
      );
      const get = (publicIPId: string) =>
        vmware.GetWorkloadNetworkPublicIP({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          publicIPId,
        });
      const observed = yield* get(resource.publicIPName);
      expect(observed.properties?.numberOfPublicIPs).toEqual(1);
      expect(resource.publicIPBlock).toBeDefined();

      // Replacement: the block size is immutable.
      const replaced = yield* stack.deploy(program({ numberOfPublicIPs: 2 }));
      expect(
        (yield* get(replaced.resource.publicIPName)).properties
          ?.numberOfPublicIPs,
      ).toEqual(2);

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.resource.publicIPName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
