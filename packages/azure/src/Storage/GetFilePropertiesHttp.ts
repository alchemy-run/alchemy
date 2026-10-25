import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { GetFileProperties } from "./GetFileProperties.ts";

/**
 * Implementation of {@link GetFileProperties} over the distilled `storage-file`
 * data plane. Assigns **Storage File Data Privileged Reader** on the share.
 *
 * @layer
 * @provides Azure.Storage.GetFileProperties
 */
export const GetFilePropertiesHttp = Layer.effect(
  GetFileProperties,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.GetFileProperties",
    operation: files.GetFileProperties,
    access: "read",
  }),
);
