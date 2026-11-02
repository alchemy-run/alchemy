import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Layer from "effect/Layer";
import { makeResourcePoolHttpBinding } from "./BindingHttp.ts";
import { ListSnapshots } from "./ListSnapshots.ts";

/**
 * HTTP implementation of {@link ListSnapshots}.
 *
 * @layer
 * @provides Stackit.FileStorage.ListSnapshots
 */
export const ListSnapshotsHttp = Layer.effect(
  ListSnapshots,
  makeResourcePoolHttpBinding({
    tag: "Stackit.FileStorage.ListSnapshots",
    access: { permissions: ["file-storage.resource-pool.snapshot.list"] },
    operation: sfs.listResourcePoolSnapshots,
  }),
);
