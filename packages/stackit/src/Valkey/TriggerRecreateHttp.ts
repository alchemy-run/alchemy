import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRecreate } from "./TriggerRecreate.ts";

/**
 * HTTP implementation of {@link TriggerRecreate}.
 *
 * @layer
 * @provides Stackit.Valkey.TriggerRecreate
 */
export const TriggerRecreateHttp = Layer.effect(
  TriggerRecreate,
  makeInstanceHttpBinding({
    tag: "Stackit.Valkey.TriggerRecreate",
    permission: "key-value-store.proxy.write",
    operation: valkey.triggerRecreate,
  }),
);
