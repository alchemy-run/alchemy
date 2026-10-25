import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobServiceOpBinding } from "./BlobContainerHttp.ts";
import { GetBlobServiceProperties } from "./GetBlobServiceProperties.ts";

/**
 * Implementation of {@link GetBlobServiceProperties} over the distilled
 * `storage-blob` data plane (`GetServiceProperties`). Grants a custom role
 * with only `blobServices/read` on the storage account.
 *
 * @layer
 * @provides Azure.Storage.GetBlobServiceProperties
 */
export const GetBlobServicePropertiesHttp = Layer.effect(
  GetBlobServiceProperties,
  makeBlobServiceOpBinding({
    tag: "Azure.Storage.GetBlobServiceProperties",
    operation: blob.GetServiceProperties,
    role: BlobRoles.ServiceReader,
  }),
);
