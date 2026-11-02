import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRestart } from "./TriggerRestart.ts";

/**
 * HTTP implementation of {@link TriggerRestart}.
 *
 * @layer
 * @provides Stackit.LogMe.TriggerRestart
 */
export const TriggerRestartHttp = Layer.effect(
  TriggerRestart,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.TriggerRestart",
    permission: "logme.proxy.write",
    operation: logme.triggerRestart,
  }),
);
