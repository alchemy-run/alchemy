import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { ChangeBlobLease } from "./ChangeBlobLease.ts";

/**
 * Implementation of {@link ChangeBlobLease} over the distilled
 * `storage-blob` data plane (`BlobChangeLease`). Grants a custom role with
 * only `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.ChangeBlobLease
 */
export const ChangeBlobLeaseHttp = Layer.effect(
  ChangeBlobLease,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.ChangeBlobLease",
    operation: blob.BlobChangeLease,
    role: BlobRoles.Writer,
  }),
);
