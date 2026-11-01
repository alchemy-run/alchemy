import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListPolicies } from "./ListPolicies.ts";

/**
 * HTTP implementation of {@link ListPolicies}.
 *
 * @layer
 * @provides Stackit.ServerBackup.ListPolicies
 */
export const ListPoliciesHttp = Layer.effect(
  ListPolicies,
  makeProjectHttpBinding({
    tag: "Stackit.ServerBackup.ListPolicies",
    access: { permissions: ["server-backup.policy.list"] },
    operation: serverBackup.listBackupPolicies,
  }),
);
