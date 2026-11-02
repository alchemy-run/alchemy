import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Layer from "effect/Layer";
import { makeResourcePoolHttpBinding } from "./BindingHttp.ts";
import { DeleteSnapshot } from "./DeleteSnapshot.ts";

/**
 * HTTP implementation of {@link DeleteSnapshot}.
 *
 * @layer
 * @provides Stackit.FileStorage.DeleteSnapshot
 */
export const DeleteSnapshotHttp = Layer.effect(
  DeleteSnapshot,
  makeResourcePoolHttpBinding({
    tag: "Stackit.FileStorage.DeleteSnapshot",
    access: { permissions: ["file-storage.resource-pool.snapshot.delete"] },
    operation: sfs.deleteResourcePoolSnapshot,
  }),
);
