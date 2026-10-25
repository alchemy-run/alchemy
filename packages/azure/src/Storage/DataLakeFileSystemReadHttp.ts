import * as Layer from "effect/Layer";
import {
  DataLakeAccess,
  makeReadDataLakeClient,
  makeFileSystemBinding,
} from "./DataLakeBindingHttp.ts";
import { DataLakeFileSystemRead } from "./DataLakeFileSystemRead.ts";

/**
 * Implementation of {@link DataLakeFileSystemRead} over the distilled `storage-datalake`
 * data plane. Assigns **Storage Blob Data Reader** on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.DataLakeFileSystemRead
 */
export const DataLakeFileSystemReadHttp = Layer.effect(
  DataLakeFileSystemRead,
  makeFileSystemBinding({
    tag: "Azure.Storage.DataLakeFileSystemRead",
    access: DataLakeAccess.read,
    makeClient: makeReadDataLakeClient,
  }),
);
