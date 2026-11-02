import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerUpdate } from "./TriggerUpdate.ts";

/**
 * HTTP implementation of {@link TriggerUpdate}.
 *
 * @layer
 * @provides Stackit.Valkey.TriggerUpdate
 */
export const TriggerUpdateHttp = Layer.effect(
  TriggerUpdate,
  makeInstanceHttpBinding({
    tag: "Stackit.Valkey.TriggerUpdate",
    permission: "key-value-store.proxy.write",
    operation: valkey.triggerUpdate,
  }),
);
