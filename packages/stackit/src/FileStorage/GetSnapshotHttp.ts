import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Layer from "effect/Layer";
import { makeResourcePoolHttpBinding } from "./BindingHttp.ts";
import { GetSnapshot } from "./GetSnapshot.ts";

/**
 * HTTP implementation of {@link GetSnapshot}.
 *
 * @layer
 * @provides Stackit.FileStorage.GetSnapshot
 */
export const GetSnapshotHttp = Layer.effect(
  GetSnapshot,
  makeResourcePoolHttpBinding({
    tag: "Stackit.FileStorage.GetSnapshot",
    access: { permissions: ["file-storage.resource-pool.snapshot.list"] },
    operation: sfs.getResourcePoolSnapshot,
  }),
);
