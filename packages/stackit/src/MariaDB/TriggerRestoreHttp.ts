import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRestore } from "./TriggerRestore.ts";

/**
 * HTTP implementation of {@link TriggerRestore}.
 *
 * @layer
 * @provides Stackit.MariaDB.TriggerRestore
 */
export const TriggerRestoreHttp = Layer.effect(
  TriggerRestore,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.TriggerRestore",
    permission: "mariadb.proxy.write",
    operation: mariadb.triggerRestore,
  }),
);
