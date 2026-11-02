import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "./BindingHttp.ts";
import { ListShareExportPolicies } from "./ListShareExportPolicies.ts";

/**
 * HTTP implementation of {@link ListShareExportPolicies}.
 *
 * @layer
 * @provides Stackit.FileStorage.ListShareExportPolicies
 */
export const ListShareExportPoliciesHttp = Layer.effect(
  ListShareExportPolicies,
  makeScopeHttpBinding({
    tag: "Stackit.FileStorage.ListShareExportPolicies",
    access: { permissions: ["file-storage.share-export-policy.list"] },
    operation: sfs.listShareExportPolicies,
  }),
);
