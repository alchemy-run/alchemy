import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { GetDirectoryProperties } from "./GetDirectoryProperties.ts";

/**
 * Implementation of {@link GetDirectoryProperties} over the distilled `storage-file`
 * data plane. Assigns **Storage File Data Privileged Reader** on the share.
 *
 * @layer
 * @provides Azure.Storage.GetDirectoryProperties
 */
export const GetDirectoryPropertiesHttp = Layer.effect(
  GetDirectoryProperties,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.GetDirectoryProperties",
    operation: files.GetDirectoryProperties,
    access: "read",
  }),
);
