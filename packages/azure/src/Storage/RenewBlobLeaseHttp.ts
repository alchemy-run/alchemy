import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { RenewBlobLease } from "./RenewBlobLease.ts";

/**
 * Implementation of {@link RenewBlobLease} over the distilled `storage-blob`
 * data plane (`RenewBlobLease`). Grants a custom role with only
 * `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.RenewBlobLease
 */
export const RenewBlobLeaseHttp = Layer.effect(
  RenewBlobLease,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.RenewBlobLease",
    operation: blob.RenewBlobLease,
    role: BlobRoles.Writer,
  }),
);
