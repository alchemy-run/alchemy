import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRestart } from "./TriggerRestart.ts";

/**
 * HTTP implementation of {@link TriggerRestart}.
 *
 * @layer
 * @provides Stackit.Valkey.TriggerRestart
 */
export const TriggerRestartHttp = Layer.effect(
  TriggerRestart,
  makeInstanceHttpBinding({
    tag: "Stackit.Valkey.TriggerRestart",
    permission: "key-value-store.proxy.write",
    operation: valkey.triggerRestart,
  }),
);
