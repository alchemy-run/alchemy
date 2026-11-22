import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { ListFileSystemBlobHierarchy } from "./ListFileSystemBlobHierarchy.ts";

/**
 * Implementation of {@link ListFileSystemBlobHierarchy} over the distilled `storage-datalake`
 * data plane. Assigns **Storage Blob Data Reader** on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.ListFileSystemBlobHierarchy
 */
export const ListFileSystemBlobHierarchyHttp = Layer.effect(
  ListFileSystemBlobHierarchy,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.ListFileSystemBlobHierarchy",
    operation: datalake.ListFileSystemBlobHierarchySegment,
    access: DataLakeAccess.read,
    endpoint: "blob",
  }),
);
