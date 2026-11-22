import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { GetBlobProperties } from "./GetBlobProperties.ts";

/**
 * Implementation of {@link GetBlobProperties} over the distilled
 * `storage-blob` data plane (`GetBlobProperties`). Grants **Storage Blob
 * Data Reader** (`blobs/read`) on the container.
 *
 * @layer
 * @provides Azure.Storage.GetBlobProperties
 */
export const GetBlobPropertiesHttp = Layer.effect(
  GetBlobProperties,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.GetBlobProperties",
    operation: blob.GetBlobProperties,
    role: BlobRoles.Reader,
  }),
);
