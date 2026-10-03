import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as elasticsan from "@distilled.cloud/azure/elasticsan";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVolume = (
  resourceGroupName: string,
  elasticSanName: string,
  volumeGroupName: string,
  volumeName: string,
) =>
  Effect.gen(function* () {
    return yield* elasticsan.GetVolume({
      subscriptionId: yield* subscription,
      resourceGroupName,
      elasticSanName,
      volumeGroupName,
      volumeName,
    });
  });

const program = (props: { name?: string; sizeGiB: number }) =>
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
      name: props.name,
      sizeGiB: props.sizeGiB,
    });
    return { group, san, volumeGroup, volume };
  });

// One 1 TiB Elastic SAN (~$0.13/hour); volumes are free: ~$0.05 per run,
// ~5 minutes.
test.provider(
  "create, grow, replace, and delete an elastic san volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ sizeGiB: 1 }));
      const rg = created.group.resourceGroupName;
      const sanName = created.san.elasticSanName;
      const vg = created.volumeGroup.volumeGroupName;
      const first = created.volume;
      expect(first.sizeGiB).toEqual(1);
      expect(first.volumeId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(first.storageTarget.targetIqn).toMatch(/^iqn\./);
      expect(first.storageTarget.targetPortalPort).toEqual(3260);
      const observed = yield* getVolume(rg, sanName, vg, first.volumeName);
      expect(observed.properties.sizeGiB).toEqual(1);

      // In-place growth.
      const grown = yield* stack.deploy(program({ sizeGiB: 2 }));
      expect(grown.volume.volumeId).toEqual(first.volumeId);
      expect(grown.volume.sizeGiB).toEqual(2);
      const reobserved = yield* getVolume(rg, sanName, vg, first.volumeName);
      expect(reobserved.properties.sizeGiB).toEqual(2);

      // Shrinking replaces the volume.
      const shrunk = yield* stack.deploy(program({ sizeGiB: 1 }));
      expect(shrunk.volume.volumeName).not.toEqual(first.volumeName);
      expect(shrunk.volume.volumeId).not.toEqual(first.volumeId);
      expect(
        yield* waitGone(getVolume(rg, sanName, vg, first.volumeName)),
      ).toEqual("gone");
      expect(shrunk.volume.sizeGiB).toEqual(1);

      // Renaming replaces the volume.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-vol-renamed", sizeGiB: 1 }),
      );
      expect(renamed.volume.volumeName).toEqual("alchemy-vol-renamed");
      yield* getVolume(rg, sanName, vg, "alchemy-vol-renamed");
      expect(
        yield* waitGone(getVolume(rg, sanName, vg, shrunk.volume.volumeName)),
      ).toEqual("gone");

      // Shrinking a volume with an explicit name replaces it under the same
      // name (delete first, then create).
      const grownNamed = yield* stack.deploy(
        program({ name: "alchemy-vol-renamed", sizeGiB: 2 }),
      );
      expect(grownNamed.volume.volumeId).toEqual(renamed.volume.volumeId);
      const reshrunk = yield* stack.deploy(
        program({ name: "alchemy-vol-renamed", sizeGiB: 1 }),
      );
      expect(reshrunk.volume.volumeName).toEqual("alchemy-vol-renamed");
      expect(reshrunk.volume.volumeId).not.toEqual(renamed.volume.volumeId);
      const named = yield* getVolume(rg, sanName, vg, "alchemy-vol-renamed");
      expect(named.properties.sizeGiB).toEqual(1);

      yield* stack.destroy();
      expect(
        yield* waitGone(getVolume(rg, sanName, vg, "alchemy-vol-renamed")),
      ).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
