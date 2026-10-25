import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Layer from "effect/Layer";
import { DataLakeAccess, makeFileSystemOperationBinding } from "./DataLakeBindingHttp.ts";
import { GetPathProperties } from "./GetPathProperties.ts";

/**
 * Implementation of {@link GetPathProperties} over the distilled `storage-datalake`
 * data plane. Assigns **Storage Blob Data Reader** on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.GetPathProperties
 */
export const GetPathPropertiesHttp = Layer.effect(
  GetPathProperties,
  makeFileSystemOperationBinding({
    tag: "Azure.Storage.GetPathProperties",
    operation: datalake.GetPathProperties,
    access: DataLakeAccess.read,
  }),
);
