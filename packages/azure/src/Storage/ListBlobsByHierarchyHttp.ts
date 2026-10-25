import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobContainerOpBinding } from "./BlobContainerHttp.ts";
import { ListBlobsByHierarchy } from "./ListBlobsByHierarchy.ts";

/**
 * Implementation of {@link ListBlobsByHierarchy} over the distilled
 * `storage-blob` data plane (`ListContainerBlobHierarchySegment`). Grants
 * **Storage Blob Data Reader** (`blobs/read`) on the container.
 *
 * @layer
 * @provides Azure.Storage.ListBlobsByHierarchy
 */
export const ListBlobsByHierarchyHttp = Layer.effect(
  ListBlobsByHierarchy,
  makeBlobContainerOpBinding({
    tag: "Azure.Storage.ListBlobsByHierarchy",
    operation: blob.ListContainerBlobHierarchySegment,
    role: BlobRoles.Reader,
  }),
);
