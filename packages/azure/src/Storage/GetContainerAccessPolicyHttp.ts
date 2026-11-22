import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { GetContainerAccessPolicy } from "./GetContainerAccessPolicy.ts";

/**
 * Implementation of {@link GetContainerAccessPolicy} over the distilled
 * `storage-blob` data plane (`GetContainerAccessPolicy`). Grants a custom
 * role with only `containers/getAcl/action` on the container.
 *
 * @layer
 * @provides Azure.Storage.GetContainerAccessPolicy
 */
export const GetContainerAccessPolicyHttp = Layer.effect(
  GetContainerAccessPolicy,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.GetContainerAccessPolicy",
    operation: blob.GetContainerAccessPolicy,
    role: BlobRoles.ContainerAclReader,
  }),
);
