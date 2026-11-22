import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { AcquireBlobLease } from "./AcquireBlobLease.ts";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";

/**
 * Implementation of {@link AcquireBlobLease} over the distilled
 * `storage-blob` data plane (`BlobAcquireLease`). Grants a custom role with
 * only `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.AcquireBlobLease
 */
export const AcquireBlobLeaseHttp = Layer.effect(
  AcquireBlobLease,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.AcquireBlobLease",
    operation: blob.BlobAcquireLease,
    role: BlobRoles.Writer,
  }),
);
