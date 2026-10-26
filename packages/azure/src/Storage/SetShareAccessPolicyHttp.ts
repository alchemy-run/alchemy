import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { SetShareAccessPolicy } from "./SetShareAccessPolicy.ts";

/**
 * Implementation of {@link SetShareAccessPolicy} over the distilled `storage-file`
 * data plane. Assigns the `AzureStorageFileSharePropertiesWriter` custom role on the share.
 *
 * @layer
 * @provides Azure.Storage.SetShareAccessPolicy
 */
export const SetShareAccessPolicyHttp = Layer.effect(
  SetShareAccessPolicy,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.SetShareAccessPolicy",
    operation: files.SetShareAccessPolicy,
    access: "shareWrite",
  }),
);
