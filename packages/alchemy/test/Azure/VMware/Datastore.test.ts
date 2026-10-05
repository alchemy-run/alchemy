import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as vmware from "@distilled.cloud/azure/vmware";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { ensureRegistered } from "@/Azure/Arm";
import * as elasticsan from "@distilled.cloud/azure/elasticsan";
import * as Schedule from "effect/Schedule";
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

const san = "alchemyavssan";

/** An Elastic SAN (1 TiB Premium_LRS) with one 100 GiB iSCSI volume. */
const createElasticSanVolume = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
) {
  yield* ensureRegistered(subscriptionId, "Microsoft.ElasticSan");
  const where = { subscriptionId, resourceGroupName, elasticSanName: san };
  yield* elasticsan.CreateElasticSan({
    ...where,
    location: "eastus",
    properties: {
      sku: { name: "Premium_LRS" },
      baseSizeTiB: 1,
      extendedCapacitySizeTiB: 0,
    },
  });
  yield* elasticsan.GetElasticSan(where).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (s) => s.properties.provisioningState === "Succeeded",
      times: 30,
    }),
  );
  yield* elasticsan.CreateVolumeGroup({
    ...where,
    volumeGroupName: "avs",
    properties: { protocolType: "Iscsi" },
  });
  yield* elasticsan.CreateVolume({
    ...where,
    volumeGroupName: "avs",
    volumeName: "datastore",
    properties: { sizeGiB: 100 },
  });
  const volume = yield* elasticsan
    .GetVolume({ ...where, volumeGroupName: "avs", volumeName: "datastore" })
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (v) => v.properties.provisioningState === "Succeeded",
        times: 30,
      }),
    );
  return volume.id ?? "";
});

const program = (props: { volumeId: string }) =>
  Effect.gen(function* () {
    const { group, cloud } = yield* privateCloud;
    const cluster = yield* Azure.VMware.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      clusterSize: 3,
    });
    yield* Azure.VMware.IscsiPath("Iscsi", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      networkBlock: "10.180.0.0/24",
    });
    const datastore = yield* Azure.VMware.Datastore("San", {
      resourceGroup: group.resourceGroupName,
      privateCloud: cloud.privateCloudName,
      cluster: cluster.clusterName,
      elasticSanVolumeId: props.volumeId,
    });
    return { group, cloud, cluster, datastore };
  });

// Needs an AVS private cloud (3 x AV36P, ~$30/hour, 3-4 hours to provision
// plus 1-2 to delete: ~$180 per run, plus ~$30/hour for the 3-host cluster and ~$0.10/hour for 1 TiB of Elastic SAN; the SAN goes away with the resource group). Free trials have no AVS host
// quota (QuotaExceeded, see the probe in PrivateCloud.test.ts).
// Skipped: failed in the last live run. QuotaExceeded: Allocation failed. You do not have
// sufficient capacity for the requested Private Cloud size in this region.
test.provider.skip(
  "attach and delete an Elastic SAN datastore",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      // The Elastic SAN volume lives out of band, in the same group.
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const volumeId = yield* createElasticSanVolume(
        subscriptionId,
        group.resourceGroupName,
      );
      const { cloud, cluster, datastore } = yield* stack.deploy(
        program({ volumeId }),
      );
      const get = () =>
        vmware.GetDatastore({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          privateCloudName: cloud.privateCloudName,
          clusterName: cluster.clusterName,
          datastoreName: datastore.datastoreName,
        });
      const observed = yield* get();
      expect(
        observed.properties?.elasticSanVolume?.targetId?.toLowerCase(),
      ).toEqual(volumeId.toLowerCase());

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: AVS_TIMEOUT },
);
