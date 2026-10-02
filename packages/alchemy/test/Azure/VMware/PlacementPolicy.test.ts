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

const program = (props: { state: "Enabled" | "Disabled" }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const cluster = yield* Azure.VMware.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      clusterSize: 3,
    });
    const policy = yield* Azure.VMware.PlacementPolicy("Spread", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      cluster: cluster.clusterName,
      type: "VmVm",
      affinityType: "AntiAffinity",
      vmMembers: [],
      state: props.state,
    });
    return { group, cloud, cluster, policy };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run, plus ~$30/hour for the 3-host cluster). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a placement policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, cluster, policy } = yield* stack.deploy(
        program({ state: "Enabled" }),
      );
      const get = () =>
        vmware.GetPlacementPolicy({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          clusterName: cluster.clusterName,
          placementPolicyName: policy.placementPolicyName,
        });
      const observed = yield* get();
      expect(observed.properties?.type).toEqual("VmVm");
      expect(observed.properties?.state).toEqual("Enabled");

      // In-place: disable the policy.
      yield* stack.deploy(program({ state: "Disabled" }));
      expect((yield* get()).properties?.state).toEqual("Disabled");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
