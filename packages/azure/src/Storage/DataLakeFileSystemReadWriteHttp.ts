import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  DataLakeAccess,
  type FileSystemAddress,
  makeFileSystemBinding,
  makeReadDataLakeClient,
  makeWriteDataLakeClient,
} from "./DataLakeBindingHttp.ts";
import { DataLakeFileSystemReadWrite } from "./DataLakeFileSystemReadWrite.ts";

/**
 * Implementation of {@link DataLakeFileSystemReadWrite} over the distilled
 * `storage-datalake` data plane. Assigns **Storage Blob Data Contributor**
 * on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.DataLakeFileSystemReadWrite
 */
export const DataLakeFileSystemReadWriteHttp = Layer.effect(
  DataLakeFileSystemReadWrite,
  makeFileSystemBinding({
    tag: "Azure.Storage.DataLakeFileSystemReadWrite",
    access: DataLakeAccess.readWrite,
    makeClient: Effect.gen(function* () {
      const makeRead = yield* makeReadDataLakeClient;
      const makeWrite = yield* makeWriteDataLakeClient;
      return (address: FileSystemAddress) => ({ ...makeRead(address), ...makeWrite(address) });
    }),
  }),
);
