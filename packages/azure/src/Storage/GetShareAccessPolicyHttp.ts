import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { GetShareAccessPolicy } from "./GetShareAccessPolicy.ts";

/**
 * Implementation of {@link GetShareAccessPolicy} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileSharePropertiesReader` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.GetShareAccessPolicy
 */
export const GetShareAccessPolicyHttp = Layer.effect(
  GetShareAccessPolicy,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.GetShareAccessPolicy",
    operation: files.GetShareAccessPolicy,
    access: "shareRead",
  }),
);
