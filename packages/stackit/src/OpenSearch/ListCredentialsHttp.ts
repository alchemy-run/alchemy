import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListCredentials } from "./ListCredentials.ts";

/**
 * HTTP implementation of {@link ListCredentials}.
 *
 * @layer
 * @provides Stackit.OpenSearch.ListCredentials
 */
export const ListCredentialsHttp = Layer.effect(
  ListCredentials,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.ListCredentials",
    permission: "opensearch.credential.list",
    operation: opensearch.listCredentials,
  }),
);
