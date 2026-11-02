import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerUpdate } from "./TriggerUpdate.ts";

/**
 * HTTP implementation of {@link TriggerUpdate}.
 *
 * @layer
 * @provides Stackit.OpenSearch.TriggerUpdate
 */
export const TriggerUpdateHttp = Layer.effect(
  TriggerUpdate,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.TriggerUpdate",
    permission: "opensearch.proxy.write",
    operation: opensearch.triggerUpdate,
  }),
);
