import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { GetFileRangeList } from "./GetFileRangeList.ts";

/**
 * Implementation of {@link GetFileRangeList} over the distilled `storage-file`
 * data plane. Assigns **Storage File Data Privileged Reader** on the share.
 *
 * @layer
 * @provides Azure.Storage.GetFileRangeList
 */
export const GetFileRangeListHttp = Layer.effect(
  GetFileRangeList,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.GetFileRangeList",
    operation: files.FileGetRangeList,
    access: "read",
  }),
);
