import type * as ingestion from "@distilled.cloud/azure/monitor-ingestion";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DataCollectionRuleTarget } from "./MonitoredResource.ts";

/**
 * The Logs Ingestion `Upload` request without the `endpoint` and `ruleId` the
 * bound rule supplies. `stream`: a stream the rule declares, e.g.
 * `Custom-AppEvents`. `body`: the rows, each a JSON object whose keys match
 * the stream's columns.
 */
export interface UploadLogsRequest extends Omit<ingestion.UploadRequest, "endpoint" | "ruleId"> {}

/**
 * Send log rows to Azure Monitor Logs through a data collection rule (the
 * Logs Ingestion API) from any host. Each row is a JSON object whose keys
 * match the rule's stream declaration. The rule's transform writes the rows
 * to its Log Analytics table, usually within a few minutes.
 *
 * Bind a {@link DataCollectionRuleTarget}. Alchemy has no data collection
 * rule resource yet, so declare the rule in an ARM template with
 * `Azure.Resources.DeploymentStack` and pass the template's outputs.
 *
 * Binding assigns a custom role (`AzureMonitorUploadLogsRole`, one per
 * stack) with exactly the data action `Microsoft.Insights/Telemetry/Write`,
 * on the data collection rule only. The built-in **Monitoring Metrics
 * Publisher** also grants `Metrics/Write`, `Register/Action`, and support
 * tickets.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link UploadLogsHttp}.
 *
 * ### Sending Logs
 * **Example:** Send rows from a Function
 * ```typescript
 * const Logs = Azure.LogAnalytics.Workspace("Logs", {});
 * const Events = Effect.gen(function* () {
 *   const workspace = yield* Logs;
 *   return yield* Azure.LogAnalytics.Table("AppEvents", {
 *     workspace: workspace.workspaceName,
 *     name: "AppEvents_CL",
 *     columns: [
 *       { name: "TimeGenerated", type: "dateTime" },
 *       { name: "Message", type: "string" },
 *     ],
 *   });
 * });
 * // A `kind: "Direct"` Microsoft.Insights/dataCollectionRules template with
 * // a `Custom-AppEvents` stream and `dcrId`, `immutableId`, and
 * // `logsIngestion` outputs.
 * const Rules = Effect.gen(function* () {
 *   const workspace = yield* Logs;
 *   const table = yield* Events;
 *   return yield* Azure.Resources.DeploymentStack("Rules", {
 *     template: rulesTemplate,
 *     parameters: {
 *       name: "app-events",
 *       location: workspace.location,
 *       workspaceId: workspace.workspaceId,
 *       table: table.tableName,
 *     },
 *   });
 * });
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const rules = yield* Rules;
 *     // init: assigns the role on the data collection rule only
 *     const upload = yield* Azure.Monitor.UploadLogs({
 *       resource: rules,
 *       dataCollectionRuleId: rules.outputs.dcrId.as<string>(),
 *       immutableId: rules.outputs.immutableId.as<string>(),
 *       logsIngestionEndpoint: rules.outputs.logsIngestion.as<string>(),
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         yield* upload({
 *           stream: "Custom-AppEvents",
 *           body: [{ TimeGenerated: new Date().toISOString(), Message: "hello" }],
 *         });
 *         return HttpServerResponse.text("sent");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Monitor.UploadLogsHttp)),
 * ) {}
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
