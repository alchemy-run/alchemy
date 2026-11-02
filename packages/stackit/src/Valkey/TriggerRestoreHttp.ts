import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRestore } from "./TriggerRestore.ts";

/**
 * HTTP implementation of {@link TriggerRestore}.
 *
 * @layer
 * @provides Stackit.Valkey.TriggerRestore
 */
export const TriggerRestoreHttp = Layer.effect(
  TriggerRestore,
  makeInstanceHttpBinding({
    tag: "Stackit.Valkey.TriggerRestore",
    permission: "key-value-store.proxy.write",
    operation: valkey.triggerRestore,
  }),
);
