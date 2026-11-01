import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRecreate } from "./TriggerRecreate.ts";

/**
 * HTTP implementation of {@link TriggerRecreate}.
 *
 * @layer
 * @provides Stackit.OpenSearch.TriggerRecreate
 */
export const TriggerRecreateHttp = Layer.effect(
  TriggerRecreate,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.TriggerRecreate",
    permission: "opensearch.proxy.write",
    operation: opensearch.triggerRecreate,
  }),
);
