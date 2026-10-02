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

const program = (props: { direction: "INGRESS" | "BIDIRECTIONAL" }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const sources = yield* Azure.VMware.WorkloadNetworkVMGroup("Sources", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      members: [],
    });
    const collectors = yield* Azure.VMware.WorkloadNetworkVMGroup(
      "Collectors",
      {
        resourceGroup: group.resourceGroupName,
        privateCloud: cloud.privateCloudName,
        members: [],
      },
    );
    const resource = yield* Azure.VMware.WorkloadNetworkPortMirroringProfile(
      "Mirror",
      {
        resourceGroup: group.resourceGroupName,
        privateCloud: cloud.privateCloudName,
        direction: props.direction,
        source: sources.vmGroupName,
        destination: collectors.vmGroupName,
      },
    );
    return { group, cloud, resource };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete an NSX port mirroring profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, resource } = yield* stack.deploy(
        program({ direction: "INGRESS" }),
      );
      const get = () =>
        vmware.GetWorkloadNetworkPortMirroring({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          portMirroringId: resource.portMirroringName,
        });
      expect((yield* get()).properties?.direction).toEqual("INGRESS");

      // In-place update.
      yield* stack.deploy(program({ direction: "BIDIRECTIONAL" }));
      expect((yield* get()).properties?.direction).toEqual("BIDIRECTIONAL");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
