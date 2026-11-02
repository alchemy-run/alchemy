import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Layer from "effect/Layer";
import { makeResourcePoolHttpBinding } from "./BindingHttp.ts";
import { CreateSnapshot } from "./CreateSnapshot.ts";

/**
 * HTTP implementation of {@link CreateSnapshot}.
 *
 * @layer
 * @provides Stackit.FileStorage.CreateSnapshot
 */
export const CreateSnapshotHttp = Layer.effect(
  CreateSnapshot,
  makeResourcePoolHttpBinding({
    tag: "Stackit.FileStorage.CreateSnapshot",
    access: { permissions: ["file-storage.resource-pool.snapshot.create"] },
    operation: sfs.createResourcePoolSnapshot,
  }),
);
