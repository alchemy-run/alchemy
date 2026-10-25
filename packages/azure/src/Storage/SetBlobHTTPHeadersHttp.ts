import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { SetBlobHTTPHeaders } from "./SetBlobHTTPHeaders.ts";

/**
 * Implementation of {@link SetBlobHTTPHeaders} over the distilled
 * `storage-blob` data plane (`SetBlobHTTPHeaders`). Grants a custom role
 * with only `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.SetBlobHTTPHeaders
 */
export const SetBlobHTTPHeadersHttp = Layer.effect(
  SetBlobHTTPHeaders,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.SetBlobHTTPHeaders",
    operation: blob.SetBlobHTTPHeaders,
    role: BlobRoles.Writer,
  }),
);
