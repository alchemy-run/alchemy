import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/** Custom table the data collection rule writes to. */
export const TABLE_NAME = "AlchemyMonEvents_CL";
/** Stream the rule declares; `UploadLogs` sends to it. */
export const STREAM_NAME = "Custom-AlchemyMonEvents";

export const Logs = Azure.LogAnalytics.Workspace("MonLogs", {});

export const Events = Effect.gen(function* () {
  const workspace = yield* Logs;
  return yield* Azure.LogAnalytics.Table("MonEvents", {
    workspace: workspace.workspaceName,
    name: TABLE_NAME,
    columns: [
      { name: "TimeGenerated", type: "datetime" },
      { name: "Message", type: "string" },
      { name: "RunId", type: "string" },
    ],
  });
});

/** A `kind: Direct` data collection rule (no DCE) from the stream to the table. */
const rulesTemplate = {
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    name: { type: "string" },
    location: { type: "string" },
    workspaceId: { type: "string" },
    table: { type: "string" },
  },
  resources: [
    {
      type: "Microsoft.Insights/dataCollectionRules",
      apiVersion: "2023-03-11",
      name: "[parameters('name')]",
      location: "[parameters('location')]",
      kind: "Direct",
      properties: {
        streamDeclarations: {
          [STREAM_NAME]: {
            columns: [
              { name: "TimeGenerated", type: "datetime" },
              { name: "Message", type: "string" },
              { name: "RunId", type: "string" },
            ],
          },
        },
        destinations: {
          logAnalytics: [{ workspaceResourceId: "[parameters('workspaceId')]", name: "logs" }],
        },
        dataFlows: [
          {
            streams: [STREAM_NAME],
            destinations: ["logs"],
            transformKql: "source",
            outputStream: "[concat('Custom-', parameters('table'))]",
          },
        ],
      },
    },
  ],
  outputs: {
    dcrId: {
      type: "string",
      value: "[resourceId('Microsoft.Insights/dataCollectionRules', parameters('name'))]",
    },
    immutableId: { type: "string", value: "[reference(parameters('name')).immutableId]" },
    logsIngestion: {
      type: "string",
      value: "[reference(parameters('name')).endpoints.logsIngestion]",
    },
  },
};

export const Rules = Effect.gen(function* () {
  const workspace = yield* Logs;
  const table = yield* Events;
  // A deployment stack deletes the rule with it.
  return yield* Azure.Resources.DeploymentStack("MonRules", {
    template: rulesTemplate,
    parameters: {
      name: "alchemy-mon-bindings",
      location: workspace.location,
      workspaceId: workspace.workspaceId,
      table: table.tableName,
    },
  });
});

/** The rule as `UploadLogs` binds it. */
export const RuleTarget = Effect.gen(function* () {
  const rules = yield* Rules;
  return {
    resource: rules,
    dataCollectionRuleId: rules.outputs.dcrId.as<string>(),
    immutableId: rules.outputs.immutableId.as<string>(),
    logsIngestion: rules.outputs.logsIngestion.as<string>(),
  };
});

/** Metrics and resource-context logs are read for this account. */
export const Metered = Azure.Storage.StorageAccount("MonMetered");

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** The first cell of the first table, e.g. `print answer = 42` → `42`. */
const firstCell = (result: { tables?: { rows: unknown[][] }[] }) =>
  result.tables?.[0]?.rows[0]?.[0];

/**
 * Effect-native Azure Function exercising every Azure Monitor and Log
 * Analytics query binding on a managed-identity host, one route per
 * binding. Routes answer `{ ok, result | error }` with a 500 on error, so a
 * caller retries through the cold start and role propagation, and a real
 * failure shows the Azure error.
 */
export default class MonitorFunction extends Azure.Functions.Function<MonitorFunction>()(
  "MonitorFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const workspace = yield* Logs;
    const rule = yield* RuleTarget;
    const account = yield* Metered;
    const metered = {
      resource: account,
      resourceId: account.storageAccountId,
      location: account.location,
    };

    const executeQuery = yield* Azure.LogAnalytics.ExecuteQuery(workspace);
    const getQuery = yield* Azure.LogAnalytics.GetQuery(workspace);
    const getMetadata = yield* Azure.LogAnalytics.GetMetadata(workspace);
    const postMetadata = yield* Azure.LogAnalytics.PostMetadata(workspace);
    const queryBatch = yield* Azure.LogAnalytics.QueryBatch(workspace);
    const executeResourceQuery = yield* Azure.LogAnalytics.ExecuteQueryWithResourceId(metered);
    const getResourceQuery = yield* Azure.LogAnalytics.GetQueryWithResourceId(metered);
    const uploadLogs = yield* Azure.Monitor.UploadLogs({
      resource: rule.resource,
      dataCollectionRuleId: rule.dataCollectionRuleId,
      immutableId: rule.immutableId,
      logsIngestionEndpoint: rule.logsIngestion,
    });
    const getMetrics = yield* Azure.Monitor.GetMetricsBatch(metered);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const run = url.searchParams.get("run") ?? "";
        switch (url.pathname) {
          case "/execute-query":
            return yield* respond(
              Effect.map(
                executeQuery({ query: "print answer = 42", timespan: "PT1H" }),
                (result) => ({ answer: firstCell(result) }),
              ),
            );
          case "/get-query":
            return yield* respond(
              Effect.map(getQuery({ query: "print answer = 43", timespan: "PT1H" }), (result) => ({
                answer: firstCell(result),
              })),
            );
          case "/get-metadata":
            return yield* respond(
              Effect.map(getMetadata(), (metadata) => ({
                tables: (metadata.tables ?? []).map((table) => table.name),
              })),
            );
          case "/post-metadata":
            return yield* respond(
              Effect.map(postMetadata(), (metadata) => ({
                tables: (metadata.tables ?? []).map((table) => table.name),
              })),
            );
          case "/query-batch":
            return yield* respond(
              Effect.map(
                queryBatch({
                  requests: [
                    { id: "one", body: { query: "print n = 1", timespan: "PT1H" } },
                    { id: "two", body: { query: "print n = 2", timespan: "PT1H" } },
                  ],
                }),
                (batch) =>
                  (batch.responses ?? [])
                    .map((response) => ({
                      id: response.id,
                      status: response.status,
                      n: firstCell(response.body ?? {}),
                    }))
                    .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? "")),
              ),
            );
          case "/execute-resource-query":
            return yield* respond(
              Effect.map(
                executeResourceQuery({ query: "print answer = 44", timespan: "PT1H" }),
                (result) => ({ answer: firstCell(result) }),
              ),
            );
          case "/get-resource-query":
            return yield* respond(
              Effect.map(
                getResourceQuery({ query: "print answer = 45", timespan: "PT1H" }),
                (result) => ({ answer: firstCell(result) }),
              ),
            );
          case "/upload-logs":
            return yield* respond(
              Effect.as(
                uploadLogs({
                  stream: STREAM_NAME,
                  body: [
                    {
                      TimeGenerated: new Date().toISOString(),
                      Message: "sent by UploadLogs",
                      RunId: run,
                    },
                  ],
                }),
                { sent: run },
              ),
            );
          case "/metrics":
            return yield* respond(
              Effect.map(
                getMetrics({
                  metricnamespace: "Microsoft.Storage/storageAccounts",
                  metricnames: ["Transactions", "Ingress"],
                  aggregation: "total",
                  interval: "PT1H",
                }),
                (result) =>
                  (result.values ?? []).map((value) => ({
                    resourceid: value.resourceid?.toLowerCase(),
                    metrics: value.value.map((metric) => metric.name.value).sort(),
                  })),
              ),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.LogAnalytics.ExecuteQueryHttp,
        Azure.LogAnalytics.GetQueryHttp,
        Azure.LogAnalytics.GetMetadataHttp,
        Azure.LogAnalytics.PostMetadataHttp,
        Azure.LogAnalytics.QueryBatchHttp,
        Azure.LogAnalytics.ExecuteQueryWithResourceIdHttp,
        Azure.LogAnalytics.GetQueryWithResourceIdHttp,
        Azure.Monitor.UploadLogsHttp,
        Azure.Monitor.GetMetricsBatchHttp,
      ),
    ),
  ),
) {}
