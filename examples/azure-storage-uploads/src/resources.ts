import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/** Only blobs under this prefix trigger the indexer. */
export const UPLOADS_PREFIX = "uploads/";

/** Partition of the `Files` table that holds one row per file. */
export const FILES_PARTITION = "files";

/** The storage account that holds the uploads and their metadata. */
export const Data = Azure.Storage.StorageAccount("Data");

/**
 * Where the uploaded bytes live. Deleting the container (on
 * `alchemy destroy`) deletes every blob in it.
 */
export const Uploads = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Uploads", {
    storageAccount: account.storageAccountName,
  });
});

/**
 * One Table storage entity per file (`PartitionKey: "files"`,
 * `RowKey: <name>`), written by the indexer once the blob has landed.
 */
export const Files = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.Table("Files", {
    storageAccount: account.storageAccountName,
  });
});

/**
 * File names double as Table row keys and blob-name suffixes, so keep
 * them to a URL- and key-safe alphabet.
 */
export const isValidName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);

export const blobFor = (name: string) => `${UPLOADS_PREFIX}${name}`;

/** What the indexer records for each upload. */
export interface FileRecord {
  name: string;
  blob: string;
  /** ETag of the blob version the indexer read. */
  blobEtag: string;
  size: number;
  contentType: string;
  sha256: string;
  indexedAt: string;
}
