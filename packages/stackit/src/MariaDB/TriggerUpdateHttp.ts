import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerUpdate } from "./TriggerUpdate.ts";

/**
 * HTTP implementation of {@link TriggerUpdate}.
 *
 * @layer
 * @provides Stackit.MariaDB.TriggerUpdate
 */
export const TriggerUpdateHttp = Layer.effect(
  TriggerUpdate,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.TriggerUpdate",
    permission: "mariadb.proxy.write",
    operation: mariadb.triggerUpdate,
  }),
);
