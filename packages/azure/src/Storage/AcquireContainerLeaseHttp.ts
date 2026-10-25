import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { AcquireContainerLease } from "./AcquireContainerLease.ts";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";

/**
 * Implementation of {@link AcquireContainerLease} over the distilled
 * `storage-blob` data plane (`ContainerAcquireLease`). Grants a custom role
 * with only `containers/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.AcquireContainerLease
 */
export const AcquireContainerLeaseHttp = Layer.effect(
  AcquireContainerLease,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.AcquireContainerLease",
    operation: blob.ContainerAcquireLease,
    role: BlobRoles.ContainerWriter,
  }),
);
