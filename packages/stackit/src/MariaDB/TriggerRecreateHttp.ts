import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRecreate } from "./TriggerRecreate.ts";

/**
 * HTTP implementation of {@link TriggerRecreate}.
 *
 * @layer
 * @provides Stackit.MariaDB.TriggerRecreate
 */
export const TriggerRecreateHttp = Layer.effect(
  TriggerRecreate,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.TriggerRecreate",
    permission: "mariadb.proxy.write",
    operation: mariadb.triggerRecreate,
  }),
);
