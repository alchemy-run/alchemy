import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobServiceOpBinding } from "./BlobContainerHttp.ts";
import { FindBlobsByTagsInAccount } from "./FindBlobsByTagsInAccount.ts";

/**
 * Implementation of {@link FindBlobsByTagsInAccount} over the distilled
 * `storage-blob` data plane (`ServiceFilterBlobs`). Grants a custom role
 * with only `blobs/filter/action` on the storage account.
 *
 * @layer
 * @provides Azure.Storage.FindBlobsByTagsInAccount
 */
export const FindBlobsByTagsInAccountHttp = Layer.effect(
  FindBlobsByTagsInAccount,
  makeBlobServiceOpBinding({
    tag: "Azure.Storage.FindBlobsByTagsInAccount",
    operation: blob.ServiceFilterBlobs,
    role: BlobRoles.TagFilter,
  }),
);
