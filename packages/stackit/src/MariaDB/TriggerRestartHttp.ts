import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRestart } from "./TriggerRestart.ts";

/**
 * HTTP implementation of {@link TriggerRestart}.
 *
 * @layer
 * @provides Stackit.MariaDB.TriggerRestart
 */
export const TriggerRestartHttp = Layer.effect(
  TriggerRestart,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.TriggerRestart",
    permission: "mariadb.proxy.write",
    operation: mariadb.triggerRestart,
  }),
);
