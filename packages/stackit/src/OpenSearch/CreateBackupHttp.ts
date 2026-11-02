import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateBackup } from "./CreateBackup.ts";

/**
 * HTTP implementation of {@link CreateBackup}.
 *
 * @layer
 * @provides Stackit.OpenSearch.CreateBackup
 */
export const CreateBackupHttp = Layer.effect(
  CreateBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.CreateBackup",
    permission: "opensearch.proxy.write",
    operation: opensearch.createBackup,
  }),
);
