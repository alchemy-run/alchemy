import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerUpdate } from "./TriggerUpdate.ts";

/**
 * HTTP implementation of {@link TriggerUpdate}.
 *
 * @layer
 * @provides Stackit.LogMe.TriggerUpdate
 */
export const TriggerUpdateHttp = Layer.effect(
  TriggerUpdate,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.TriggerUpdate",
    permission: "logme.proxy.write",
    operation: logme.triggerUpdate,
  }),
);
