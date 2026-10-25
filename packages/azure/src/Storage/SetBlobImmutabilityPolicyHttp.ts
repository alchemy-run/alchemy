import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { SetBlobImmutabilityPolicy } from "./SetBlobImmutabilityPolicy.ts";

/**
 * Implementation of {@link SetBlobImmutabilityPolicy} over the distilled
 * `storage-blob` data plane (`SetBlobImmutabilityPolicy`). Grants a custom
 * role with only `blobs/immutableStorage/runAsSuperUser/action` on the
 * container.
 *
 * @layer
 * @provides Azure.Storage.SetBlobImmutabilityPolicy
 */
export const SetBlobImmutabilityPolicyHttp = Layer.effect(
  SetBlobImmutabilityPolicy,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.SetBlobImmutabilityPolicy",
    operation: blob.SetBlobImmutabilityPolicy,
    role: BlobRoles.ImmutabilityAdmin,
  }),
);
