import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRestart } from "./TriggerRestart.ts";

/**
 * HTTP implementation of {@link TriggerRestart}.
 *
 * @layer
 * @provides Stackit.OpenSearch.TriggerRestart
 */
export const TriggerRestartHttp = Layer.effect(
  TriggerRestart,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.TriggerRestart",
    permission: "opensearch.proxy.write",
    operation: opensearch.triggerRestart,
  }),
);
