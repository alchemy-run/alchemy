import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { DownloadFile } from "./DownloadFile.ts";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";

/**
 * Implementation of {@link DownloadFile} over the distilled `storage-file`
 * data plane. Assigns **Storage File Data Privileged Reader** on the share.
 *
 * @layer
 * @provides Azure.Storage.DownloadFile
 */
export const DownloadFileHttp = Layer.effect(
  DownloadFile,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.DownloadFile",
    operation: files.DownloadFile,
    access: "read",
  }),
);
