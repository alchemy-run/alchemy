import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { ListPaths } from "./ListPaths.ts";

/**
 * Implementation of {@link ListPaths} over the distilled `storage-datalake`
 * data plane. Assigns **Storage Blob Data Reader** on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.ListPaths
 */
export const ListPathsHttp = Layer.effect(
  ListPaths,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.ListPaths",
    operation: datalake.ListFileSystemPaths,
    access: DataLakeAccess.read,
  }),
);
