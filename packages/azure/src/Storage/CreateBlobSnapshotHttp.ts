import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { CreateBlobSnapshot } from "./CreateBlobSnapshot.ts";

/**
 * Implementation of {@link CreateBlobSnapshot} over the distilled
 * `storage-blob` data plane (`CreateBlobSnapshot`). Grants a custom role
 * with only `blobs/write` on the container.
 *
 * @layer
 * @provides Azure.Storage.CreateBlobSnapshot
 */
export const CreateBlobSnapshotHttp = Layer.effect(
  CreateBlobSnapshot,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.CreateBlobSnapshot",
    operation: blob.CreateBlobSnapshot,
    role: BlobRoles.Writer,
  }),
);
