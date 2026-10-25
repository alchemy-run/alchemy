import type * as ingestion from "@distilled.cloud/azure/monitor-ingestion";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DataCollectionRuleTarget } from "./MonitoredResource.ts";

export interface UploadLogsRequest extends Omit<ingestion.UploadRequest, "endpoint" | "ruleId"> {}

/**
 * Send log rows to Azure Monitor Logs through a data collection rule (the
 * Logs Ingestion API) from any host. Each row is a JSON object whose keys
 * match the rule's stream declaration; the rule's transform writes them to
 * its Log Analytics table, usually within a few minutes.
 *
 * Binding assigns a custom role (`AzureMonitorUploadLogsRole`, one per
 * stack) with exactly the data action `Microsoft.Insights/Telemetry/Write`,
 * on the data collection rule only. The built-in **Monitoring Metrics
 * Publisher** also grants `Metrics/Write`, `Register/Action`, and support
 * tickets. On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`). Provide {@link UploadLogsHttp}.
 *
 * ### Sending Logs
 * **Example:** Send rows from a Function
 * ```typescript
 * // init
 * const upload = yield* Azure.Monitor.UploadLogs({
 *   resource: rules,
 *   dataCollectionRuleId: rules.outputs.dcrId.as<string>(),
 *   immutableId: rules.outputs.immutableId.as<string>(),
 *   logsIngestionEndpoint: rules.outputs.logsIngestion.as<string>(),
 * });
 *
 * // runtime
 * yield* upload({
 *   stream: "Custom-AppEvents_CL",
 *   body: [{ TimeGenerated: new Date().toISOString(), Message: "hello" }],
 * });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const upload = yield* Azure.Monitor.UploadLogs(target);
 *   // ...
 * }).pipe(Effect.provide(Azure.Monitor.UploadLogsHttp));
 * ```
 *
 * @binding
 * @category Monitor
 */
export interface UploadLogs extends Binding.Service<
  UploadLogs,
  "Azure.Monitor.UploadLogs",
  (
    rule: DataCollectionRuleTarget,
  ) => Effect.Effect<
    (
      request: UploadLogsRequest,
    ) => Effect.Effect<ingestion.UploadResponse, ingestion.UploadError, RuntimeContext>
  >
> {}

export const UploadLogs = Binding.Service<UploadLogs>("Azure.Monitor.UploadLogs");
