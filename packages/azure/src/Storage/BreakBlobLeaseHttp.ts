import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { BreakBlobLease } from "./BreakBlobLease.ts";

/**
 * Implementation of {@link BreakBlobLease} over the distilled `storage-blob`
 * data plane (`BlobBreakLease`). Grants a custom role with only
 * `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.BreakBlobLease
 */
export const BreakBlobLeaseHttp = Layer.effect(
  BreakBlobLease,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.BreakBlobLease",
    operation: blob.BlobBreakLease,
    role: BlobRoles.Writer,
  }),
);
