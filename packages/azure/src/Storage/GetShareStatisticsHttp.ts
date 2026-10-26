import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { GetShareStatistics } from "./GetShareStatistics.ts";

/**
 * Implementation of {@link GetShareStatistics} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileSharePropertiesReader` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.GetShareStatistics
 */
export const GetShareStatisticsHttp = Layer.effect(
  GetShareStatistics,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.GetShareStatistics",
    operation: files.GetShareStatistics,
    access: "shareRead",
  }),
);
