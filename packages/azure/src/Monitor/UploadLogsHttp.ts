import * as Layer from "effect/Layer";
import { makeUploadLogsBinding } from "./BindingHttp.ts";
import { UploadLogs } from "./UploadLogs.ts";

/**
 * Implementation of {@link UploadLogs} over the distilled
 * `monitor-ingestion` data plane. Assigns the custom
 * `AzureMonitorUploadLogsRole` (`Microsoft.Insights/Telemetry/Write`) on
 * the data collection rule.
 *
 * @layer
 * @provides Azure.Monitor.UploadLogs
 */
export const UploadLogsHttp = Layer.effect(
  UploadLogs,
  makeUploadLogsBinding("Azure.Monitor.UploadLogs"),
);
