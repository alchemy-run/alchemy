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

const program = (props: { clusterSize: number }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const cluster = yield* Azure.VMware.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      sku: "av36p",
      clusterSize: props.clusterSize,
    });
    return { group, cloud, cluster };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run, plus ~$10/hour per cluster host). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
// Skipped: failed in the last live run. QuotaExceeded: Allocation failed. You do not have
// sufficient capacity for the requested Private Cloud size in this region.
test.provider.skip(
  "create, scale, and delete a cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const { group, cloud, cluster } = yield* stack.deploy(
        program({ clusterSize: 3 }),
      );
      const get = () =>
        vmware.GetCluster({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          clusterName: cluster.clusterName,
        });
      const observed = yield* get();
      expect(observed.properties?.clusterSize).toEqual(3);
      expect(observed.sku.name.toLowerCase()).toEqual("av36p");

      // In-place: add a host.
      const scaled = yield* stack.deploy(program({ clusterSize: 4 }));
      expect(scaled.cluster.clusterResourceId).toEqual(
        cluster.clusterResourceId,
      );
      expect((yield* get()).properties?.clusterSize).toEqual(4);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
