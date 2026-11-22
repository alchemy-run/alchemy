import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Layer from "effect/Layer";
import { BlobRoles, makeBlobServiceOpBinding } from "./BlobContainerHttp.ts";
import { GetBlobServiceStatistics } from "./GetBlobServiceStatistics.ts";

/**
 * Implementation of {@link GetBlobServiceStatistics} over the distilled
 * `storage-blob` data plane (`GetServiceStatistics`). Grants a custom role
 * with only `blobServices/read` on the storage account.
 *
 * @layer
 * @provides Azure.Storage.GetBlobServiceStatistics
 */
export const GetBlobServiceStatisticsHttp = Layer.effect(
  GetBlobServiceStatistics,
  makeBlobServiceOpBinding({
    tag: "Azure.Storage.GetBlobServiceStatistics",
    operation: blob.GetServiceStatistics,
    role: BlobRoles.ServiceReader,
    secondary: true,
  }),
);
