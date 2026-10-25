import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobServiceOpBinding } from "./BlobContainerHttp.ts";
import { SetBlobServiceProperties } from "./SetBlobServiceProperties.ts";

/**
 * Implementation of {@link SetBlobServiceProperties} over the distilled
 * `storage-blob` data plane (`SetServiceProperties`). Grants a custom role
 * with only `blobServices/write` on the storage account.
 *
 * @layer
 * @provides Azure.Storage.SetBlobServiceProperties
 */
export const SetBlobServicePropertiesHttp = Layer.effect(
  SetBlobServiceProperties,
  makeBlobServiceOpBinding({
    tag: "Azure.Storage.SetBlobServiceProperties",
    operation: blob.SetServiceProperties,
    role: BlobRoles.ServiceWriter,
  }),
);
