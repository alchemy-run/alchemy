import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { RenewContainerLease } from "./RenewContainerLease.ts";

/**
 * Implementation of {@link RenewContainerLease} over the distilled
 * `storage-blob` data plane (`RenewContainerLease`). Grants a custom role
 * with only `containers/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.RenewContainerLease
 */
export const RenewContainerLeaseHttp = Layer.effect(
  RenewContainerLease,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.RenewContainerLease",
    operation: blob.RenewContainerLease,
    role: BlobRoles.ContainerWriter,
  }),
);
