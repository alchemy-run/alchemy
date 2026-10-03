import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as elasticsan from "@distilled.cloud/azure/elasticsan";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSnapshot = (
  resourceGroupName: string,
  elasticSanName: string,
  volumeGroupName: string,
  snapshotName: string,
) =>
  Effect.gen(function* () {
    return yield* elasticsan.GetVolumeSnapshot({
      subscriptionId: yield* subscription,
      resourceGroupName,
      elasticSanName,
      volumeGroupName,
      snapshotName,
    });
  });

const program = (props: { name?: string; restore: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const san = yield* Azure.ElasticSan.ElasticSan("San", {
      resourceGroup: group.resourceGroupName,
    });
    const volumeGroup = yield* Azure.ElasticSan.VolumeGroup("Volumes", {
      resourceGroup: group.resourceGroupName,
      elasticSan: san.elasticSanName,
    });
    const volume = yield* Azure.ElasticSan.Volume("Data", {
      resourceGroup: group.resourceGroupName,
      elasticSan: san.elasticSanName,
      volumeGroup: volumeGroup.volumeGroupName,
      sizeGiB: 1,
    });
    const snapshot = yield* Azure.ElasticSan.Snapshot("Backup", {
      resourceGroup: group.resourceGroupName,
      elasticSan: san.elasticSanName,
      volumeGroup: volumeGroup.volumeGroupName,
      name: props.name,
      sourceVolumeId: volume.volumeResourceId,
    });
    const restored = props.restore
      ? yield* Azure.ElasticSan.Volume("Restored", {
          resourceGroup: group.resourceGroupName,
          elasticSan: san.elasticSanName,
          volumeGroup: volumeGroup.volumeGroupName,
          sizeGiB: 1,
          creationData: {
            createSource: "VolumeSnapshot",
            sourceId: snapshot.snapshotId,
          },
        })
      : undefined;
    return { group, san, volumeGroup, volume, snapshot, restored };
  });

// One 1 TiB Elastic SAN (~$0.13/hour); snapshots of an empty 1 GiB volume
// are effectively free: ~$0.05 per run, ~5 minutes.
test.provider(
  "create, restore from, replace, and delete an elastic san snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ restore: true }));
      const rg = created.group.resourceGroupName;
      const sanName = created.san.elasticSanName;
      const vg = created.volumeGroup.volumeGroupName;
      const first = created.snapshot;
      expect(first.sourceVolumeId.toLowerCase()).toEqual(
        created.volume.volumeResourceId.toLowerCase(),
      );
      expect(first.volumeName).toEqual(created.volume.volumeName);
      expect(first.sourceVolumeSizeGiB).toEqual(1);
      const observed = yield* getSnapshot(rg, sanName, vg, first.snapshotName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");

      // A volume restored from the snapshot.
      expect(created.restored!.createSource).toEqual("VolumeSnapshot");
      expect(created.restored!.sourceId?.toLowerCase()).toEqual(
        first.snapshotId.toLowerCase(),
      );

      // Drop the restored volume, then rename (replace) the snapshot.
      yield* stack.deploy(program({ restore: false }));
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-snap-renamed", restore: false }),
      );
      expect(renamed.snapshot.snapshotName).toEqual("alchemy-snap-renamed");
      yield* getSnapshot(rg, sanName, vg, "alchemy-snap-renamed");
      expect(
        yield* waitGone(getSnapshot(rg, sanName, vg, first.snapshotName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getSnapshot(rg, sanName, vg, "alchemy-snap-renamed")),
      ).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
