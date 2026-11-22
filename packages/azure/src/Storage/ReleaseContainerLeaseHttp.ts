import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { ReleaseContainerLease } from "./ReleaseContainerLease.ts";

/**
 * Implementation of {@link ReleaseContainerLease} over the distilled
 * `storage-blob` data plane (`ContainerReleaseLease`). Grants a custom role
 * with only `containers/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.ReleaseContainerLease
 */
export const ReleaseContainerLeaseHttp = Layer.effect(
  ReleaseContainerLease,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.ReleaseContainerLease",
    operation: blob.ContainerReleaseLease,
    role: BlobRoles.ContainerWriter,
  }),
);
