import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { AppendBlockFromUrl } from "./AppendBlockFromUrl.ts";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";

/**
 * Implementation of {@link AppendBlockFromUrl} over the distilled
 * `storage-blob` data plane (`AppendBlobAppendBlockFromUrl`). Grants a
 * custom role with only `blobs/write` (Azure reads the source with the URL's
 * own authorization: public, a SAS, or `xMsCopySourceAuthorization`) on the
 * container.
 *
 * @layer
 * @provides Azure.Storage.AppendBlockFromUrl
 */
export const AppendBlockFromUrlHttp = Layer.effect(
  AppendBlockFromUrl,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.AppendBlockFromUrl",
    operation: blob.AppendBlobAppendBlockFromUrl,
    role: BlobRoles.Writer,
  }),
);
