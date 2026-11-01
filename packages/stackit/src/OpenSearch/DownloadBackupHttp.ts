import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DownloadBackup } from "./DownloadBackup.ts";

/**
 * HTTP implementation of {@link DownloadBackup}.
 *
 * @layer
 * @provides Stackit.OpenSearch.DownloadBackup
 */
export const DownloadBackupHttp = Layer.effect(
  DownloadBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.DownloadBackup",
    permission: "opensearch.proxy.read",
    operation: opensearch.downloadBackup,
  }),
);
