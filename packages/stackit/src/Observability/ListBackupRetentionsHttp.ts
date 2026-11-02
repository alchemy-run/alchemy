import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListBackupRetentions } from "./ListBackupRetentions.ts";

/**
 * HTTP implementation of {@link ListBackupRetentions}.
 *
 * @layer
 * @provides Stackit.Observability.ListBackupRetentions
 */
export const ListBackupRetentionsHttp = Layer.effect(
  ListBackupRetentions,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListBackupRetentions",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listBackupRetentions,
  }),
);
