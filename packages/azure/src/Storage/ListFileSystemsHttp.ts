import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeAccountOperationBinding } from "./DataLakeBindingHttp.ts";
import { ListFileSystems } from "./ListFileSystems.ts";

/**
 * Implementation of {@link ListFileSystems} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `Microsoft.Storage/storageAccounts/blobServices/containers/read` on the storage account only.
 *
 * @layer
 * @provides Azure.Storage.ListFileSystems
 */
export const ListFileSystemsHttp = Layer.effect(
  ListFileSystems,
  makeAccountOperationBinding({
    tag: "Azure.Storage.ListFileSystems",
    operation: datalake.ListServiceFileSystems,
    access: DataLakeAccess.fileSystemRead,
  }),
);
