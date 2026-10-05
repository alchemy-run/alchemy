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

const program = (props: { gatewayAddress: string }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const resource = yield* Azure.VMware.WorkloadNetworkSegment("Segment", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      displayName: "alchemy-segment",
      connectedGateway: "/infra/tier-1s/TNT-T1",
      subnet: { gatewayAddress: props.gatewayAddress },
    });

    return { group, cloud, resource };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
// Skipped: failed in the last live run. QuotaExceeded: Allocation failed. You do not have
// sufficient capacity for the requested Private Cloud size in this region.
test.provider.skip(
  "create, update, and delete an NSX segment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, resource } = yield* stack.deploy(
        program({ gatewayAddress: "10.190.0.1/24" }),
      );
      const get = () =>
        vmware.GetWorkloadNetworkSegment({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          segmentId: resource.segmentName,
        });
      const observed = yield* get();
      expect(observed.properties?.subnet?.gatewayAddress).toEqual(
        "10.190.0.1/24",
      );

      // In-place update.
      const updated = yield* stack.deploy(
        program({ gatewayAddress: "10.191.0.1/24" }),
      );
      expect(updated.resource.segmentName).toEqual(resource.segmentName);
      const reobserved = yield* get();
      expect(reobserved.properties?.subnet?.gatewayAddress).toEqual(
        "10.191.0.1/24",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
