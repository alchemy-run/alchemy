import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { SetContainerAccessPolicy } from "./SetContainerAccessPolicy.ts";

/**
 * Implementation of {@link SetContainerAccessPolicy} over the distilled
 * `storage-blob` data plane (`SetContainerAccessPolicy`). Grants a custom
 * role with only `containers/setAcl/action` on the container.
 *
 * @layer
 * @provides Azure.Storage.SetContainerAccessPolicy
 */
export const SetContainerAccessPolicyHttp = Layer.effect(
  SetContainerAccessPolicy,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.SetContainerAccessPolicy",
    operation: blob.SetContainerAccessPolicy,
    role: BlobRoles.ContainerAclWriter,
  }),
);
