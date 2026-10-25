import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { ListFilesAndDirectories } from "./ListFilesAndDirectories.ts";

/**
 * Implementation of {@link ListFilesAndDirectories} over the distilled `storage-file`
 * data plane. Assigns **Storage File Data Privileged Reader** on the share.
 *
 * @layer
 * @provides Azure.Storage.ListFilesAndDirectories
 */
export const ListFilesAndDirectoriesHttp = Layer.effect(
  ListFilesAndDirectories,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.ListFilesAndDirectories",
    operation: files.DirectoryListFilesAndDirectoriesSegment,
    access: "read",
  }),
);
