import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Layer from "effect/Layer";
import { makeShareExportPolicyHttpBinding } from "./BindingHttp.ts";
import { GetShareExportPolicy } from "./GetShareExportPolicy.ts";

/**
 * HTTP implementation of {@link GetShareExportPolicy}.
 *
 * @layer
 * @provides Stackit.FileStorage.GetShareExportPolicy
 */
export const GetShareExportPolicyHttp = Layer.effect(
  GetShareExportPolicy,
  makeShareExportPolicyHttpBinding({
    tag: "Stackit.FileStorage.GetShareExportPolicy",
    access: { permissions: ["file-storage.share-export-policy.list"] },
    operation: sfs.getShareExportPolicy,
  }),
);
