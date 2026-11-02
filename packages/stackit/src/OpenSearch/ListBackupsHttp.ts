import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListBackups } from "./ListBackups.ts";

/**
 * HTTP implementation of {@link ListBackups}.
 *
 * @layer
 * @provides Stackit.OpenSearch.ListBackups
 */
export const ListBackupsHttp = Layer.effect(
  ListBackups,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.ListBackups",
    permission: "opensearch.proxy.read",
    operation: opensearch.listBackups,
  }),
);
