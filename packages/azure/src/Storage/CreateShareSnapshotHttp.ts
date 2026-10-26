import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { CreateShareSnapshot } from "./CreateShareSnapshot.ts";

/**
 * Implementation of {@link CreateShareSnapshot} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileSharePropertiesWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.CreateShareSnapshot
 */
export const CreateShareSnapshotHttp = Layer.effect(
  CreateShareSnapshot,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.CreateShareSnapshot",
    operation: files.CreateShareSnapshot,
    access: "shareWrite",
  }),
);
