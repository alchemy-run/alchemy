import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { GetContainerProperties } from "./GetContainerProperties.ts";

/**
 * Implementation of {@link GetContainerProperties} over the distilled
 * `storage-blob` data plane (`GetContainerProperties`). Grants a custom role
 * with only `containers/read` on the container.
 *
 * @layer
 * @provides Azure.Storage.GetContainerProperties
 */
export const GetContainerPropertiesHttp = Layer.effect(
  GetContainerProperties,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.GetContainerProperties",
    operation: blob.GetContainerProperties,
    role: BlobRoles.ContainerReader,
  }),
);
