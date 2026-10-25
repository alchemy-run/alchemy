import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { StageBlockFromUrl } from "./StageBlockFromUrl.ts";

/**
 * Implementation of {@link StageBlockFromUrl} over the distilled
 * `storage-blob` data plane (`BlockBlobStageBlockFromURL`). Grants a custom
 * role with only `blobs/write` (Azure reads the source with the URL's own
 * authorization: public, a SAS, or `xMsCopySourceAuthorization`) on the
 * container.
 *
 * @layer
 * @provides Azure.Storage.StageBlockFromUrl
 */
export const StageBlockFromUrlHttp = Layer.effect(
  StageBlockFromUrl,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.StageBlockFromUrl",
    operation: blob.BlockBlobStageBlockFromURL,
    role: BlobRoles.Writer,
  }),
);
