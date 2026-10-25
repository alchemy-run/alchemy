import * as Layer from "effect/Layer";
import {
  DataLakeAccess,
  makeWriteDataLakeClient,
  makeFileSystemBinding,
} from "./DataLakeBindingHttp.ts";
import { DataLakeFileSystemWrite } from "./DataLakeFileSystemWrite.ts";

/**
 * Implementation of {@link DataLakeFileSystemWrite} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `blobs/write`, `blobs/delete`, `blobs/move/action`, and `blobs/add/action` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.DataLakeFileSystemWrite
 */
export const DataLakeFileSystemWriteHttp = Layer.effect(
  DataLakeFileSystemWrite,
  makeFileSystemBinding({
    tag: "Azure.Storage.DataLakeFileSystemWrite",
    access: DataLakeAccess.writeOnly,
    makeClient: makeWriteDataLakeClient,
  }),
);
