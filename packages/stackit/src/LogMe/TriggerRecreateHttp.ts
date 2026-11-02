import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRecreate } from "./TriggerRecreate.ts";

/**
 * HTTP implementation of {@link TriggerRecreate}.
 *
 * @layer
 * @provides Stackit.LogMe.TriggerRecreate
 */
export const TriggerRecreateHttp = Layer.effect(
  TriggerRecreate,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.TriggerRecreate",
    permission: "logme.proxy.write",
    operation: logme.triggerRecreate,
  }),
);
