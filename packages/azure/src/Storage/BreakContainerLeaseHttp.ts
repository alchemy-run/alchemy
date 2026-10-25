import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { BreakContainerLease } from "./BreakContainerLease.ts";

/**
 * Implementation of {@link BreakContainerLease} over the distilled
 * `storage-blob` data plane (`ContainerBreakLease`). Grants a custom role
 * with only `containers/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.BreakContainerLease
 */
export const BreakContainerLeaseHttp = Layer.effect(
  BreakContainerLease,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.BreakContainerLease",
    operation: blob.ContainerBreakLease,
    role: BlobRoles.ContainerWriter,
  }),
);
