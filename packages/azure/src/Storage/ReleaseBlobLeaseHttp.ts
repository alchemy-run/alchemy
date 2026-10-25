import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { ReleaseBlobLease } from "./ReleaseBlobLease.ts";

/**
 * Implementation of {@link ReleaseBlobLease} over the distilled
 * `storage-blob` data plane (`BlobReleaseLease`). Grants a custom role with
 * only `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.ReleaseBlobLease
 */
export const ReleaseBlobLeaseHttp = Layer.effect(
  ReleaseBlobLease,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.ReleaseBlobLease",
    operation: blob.BlobReleaseLease,
    role: BlobRoles.Writer,
  }),
);
