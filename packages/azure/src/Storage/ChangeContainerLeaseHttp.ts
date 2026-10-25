import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { ChangeContainerLease } from "./ChangeContainerLease.ts";

/**
 * Implementation of {@link ChangeContainerLease} over the distilled
 * `storage-blob` data plane (`ContainerChangeLease`). Grants a custom role
 * with only `containers/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.ChangeContainerLease
 */
export const ChangeContainerLeaseHttp = Layer.effect(
  ChangeContainerLease,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.ChangeContainerLease",
    operation: blob.ContainerChangeLease,
    role: BlobRoles.ContainerWriter,
  }),
);
