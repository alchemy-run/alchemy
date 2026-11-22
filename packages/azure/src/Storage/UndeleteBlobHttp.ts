import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { UndeleteBlob } from "./UndeleteBlob.ts";

/**
 * Implementation of {@link UndeleteBlob} over the distilled `storage-blob`
 * data plane (`UndeleteBlob`). Grants a custom role with only `blobs/write`
 * on the container.
 *
 * @layer
 * @provides Azure.Storage.UndeleteBlob
 */
export const UndeleteBlobHttp = Layer.effect(
  UndeleteBlob,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.UndeleteBlob",
    operation: blob.UndeleteBlob,
    role: BlobRoles.Writer,
  }),
);
