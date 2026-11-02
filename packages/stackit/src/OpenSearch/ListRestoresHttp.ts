import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListRestores } from "./ListRestores.ts";

/**
 * HTTP implementation of {@link ListRestores}.
 *
 * @layer
 * @provides Stackit.OpenSearch.ListRestores
 */
export const ListRestoresHttp = Layer.effect(
  ListRestores,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.ListRestores",
    permission: "opensearch.proxy.read",
    operation: opensearch.listRestores,
  }),
);
