import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { SetBlobLegalHold } from "./SetBlobLegalHold.ts";

/**
 * Implementation of {@link SetBlobLegalHold} over the distilled
 * `storage-blob` data plane (`SetBlobLegalHold`). Grants a custom role with
 * only `containers/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.SetBlobLegalHold
 */
export const SetBlobLegalHoldHttp = Layer.effect(
  SetBlobLegalHold,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.SetBlobLegalHold",
    operation: blob.SetBlobLegalHold,
    role: BlobRoles.ContainerWriter,
  }),
);
