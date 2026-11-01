import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetUpdates } from "./GetUpdates.ts";

/**
 * HTTP implementation of {@link GetUpdates}.
 *
 * @layer
 * @provides Stackit.OpenSearch.GetUpdates
 */
export const GetUpdatesHttp = Layer.effect(
  GetUpdates,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.GetUpdates",
    permission: "opensearch.proxy.read",
    operation: opensearch.getUpdates,
  }),
);
