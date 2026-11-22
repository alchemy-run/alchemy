import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { DeleteBlobImmutabilityPolicy } from "./DeleteBlobImmutabilityPolicy.ts";

/**
 * Implementation of {@link DeleteBlobImmutabilityPolicy} over the distilled
 * `storage-blob` data plane (`DeleteBlobImmutabilityPolicy`). Grants a
 * custom role with only `blobs/immutableStorage/runAsSuperUser/action` on
 * the container.
 *
 * @layer
 * @provides Azure.Storage.DeleteBlobImmutabilityPolicy
 */
export const DeleteBlobImmutabilityPolicyHttp = Layer.effect(
  DeleteBlobImmutabilityPolicy,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.DeleteBlobImmutabilityPolicy",
    operation: blob.DeleteBlobImmutabilityPolicy,
    role: BlobRoles.ImmutabilityAdmin,
  }),
);
