import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kr from "@distilled.cloud/azure/kubernetesruntime";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { arcClusterId, logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getStorageClass = (clusterId: string, storageClassName: string) =>
  kr.GetStorageClass({ resourceUri: clusterId, storageClassName });

const program = (props: {
  share: string;
  priority: number;
  volumeBindingMode: "Immediate" | "WaitForFirstConsumer";
}) =>
  Effect.gen(function* () {
    const storage = yield* Azure.KubernetesRuntime.Service("Storage", {
      clusterId: arcClusterId!,
      serviceName: "storageclass",
    });
    const storageClass = yield* Azure.KubernetesRuntime.StorageClass("Nfs", {
      clusterId: storage.clusterId,
      typeProperties: {
        type: "NFS",
        server: "10.0.0.4",
        share: props.share,
        onDelete: "Retain",
      },
      volumeBindingMode: props.volumeBindingMode,
      accessModes: ["ReadWriteOnce", "ReadWriteMany"],
      priority: props.priority,
    });
    return { storageClass };
  });

// Needs a connected Arc cluster with the `microsoft.arc.containerstorage`
// extension (see util.ts); the storage class object itself is free (the
// NFS server is never mounted because no volume is provisioned).
test.provider.skipIf(!arcClusterId)(
  "create, update, replace, and delete a storage class",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const clusterId = arcClusterId!;

      const { storageClass } = yield* stack.deploy(
        program({
          share: "/exports/a",
          priority: 10,
          volumeBindingMode: "Immediate",
        }),
      );
      expect(storageClass.type).toEqual("NFS");
      const observed = yield* getStorageClass(
        clusterId,
        storageClass.storageClassName,
      );
      expect(observed.properties?.typeProperties.share).toEqual("/exports/a");
      expect(observed.properties?.priority).toEqual(10);

      // In place: priority and the NFS share are PATCHed.
      const updated = yield* stack.deploy(
        program({
          share: "/exports/b",
          priority: 20,
          volumeBindingMode: "Immediate",
        }),
      );
      expect(updated.storageClass.storageClassId).toEqual(
        storageClass.storageClassId,
      );
      const reobserved = yield* getStorageClass(
        clusterId,
        storageClass.storageClassName,
      );
      expect(reobserved.properties?.priority).toEqual(20);
      expect(reobserved.properties?.typeProperties.share).toEqual("/exports/b");

      // Replacement: the volume binding mode is create-only.
      const replaced = yield* stack.deploy(
        program({
          share: "/exports/b",
          priority: 20,
          volumeBindingMode: "WaitForFirstConsumer",
        }),
      );
      expect(replaced.storageClass.storageClassName).not.toEqual(
        storageClass.storageClassName,
      );
      expect(
        (yield* getStorageClass(
          clusterId,
          replaced.storageClass.storageClassName,
        )).properties?.volumeBindingMode,
      ).toEqual("WaitForFirstConsumer");
      expect(
        yield* waitGone(
          getStorageClass(clusterId, storageClass.storageClassName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getStorageClass(clusterId, replaced.storageClass.storageClassName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
