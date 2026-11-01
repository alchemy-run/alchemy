import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRestore } from "./TriggerRestore.ts";

/**
 * HTTP implementation of {@link TriggerRestore}.
 *
 * @layer
 * @provides Stackit.OpenSearch.TriggerRestore
 */
export const TriggerRestoreHttp = Layer.effect(
  TriggerRestore,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.TriggerRestore",
    permission: "opensearch.proxy.write",
    operation: opensearch.triggerRestore,
  }),
);
