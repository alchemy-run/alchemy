import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobServiceOpBinding } from "./BlobContainerHttp.ts";
import { ListBlobContainers } from "./ListBlobContainers.ts";

/**
 * Implementation of {@link ListBlobContainers} over the distilled
 * `storage-blob` data plane (`ListServiceContainersSegment`). Grants a
 * custom role with only `containers/read` on the storage account.
 *
 * @layer
 * @provides Azure.Storage.ListBlobContainers
 */
export const ListBlobContainersHttp = Layer.effect(
  ListBlobContainers,
  makeBlobServiceOpBinding({
    tag: "Azure.Storage.ListBlobContainers",
    operation: blob.ListServiceContainersSegment,
    role: BlobRoles.ContainerReader,
  }),
);
