import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { loggerNameOf, sameName, subsetMatches } from "./Common.ts";
import type {
  DiagnosticCorrelationProtocol,
  DiagnosticOperationNameFormat,
  DiagnosticPipelineSettings,
  DiagnosticSampling,
  DiagnosticVerbosity,
} from "./Diagnostic.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceApiDiagnosticProps {
  /** Resource group of the API Management service. Changing it replaces the diagnostic. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the diagnostic. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
  /** Identifier of the API the diagnostic applies to. Changing it replaces the diagnostic. */
  apiName: string;
  /**
   * Diagnostic identifier, which selects the sink family. `azuremonitor`
   * is not available on the Consumption tier. Changing it replaces the
   * diagnostic.
   * @default "applicationinsights"
   */
  name?: "applicationinsights" | "azuremonitor";
  /** ARM resource ID of the logger that receives the telemetry (`Logger.loggerId`). */
  loggerId: string;
  /**
   * Message types that bypass sampling (`allErrors`).
   * @default not set (Azure's default applies)
   */
  alwaysLog?: "allErrors";
  /**
   * Sampling settings, e.g. `{ samplingType: "fixed", percentage: 50 }`.
   * @default not set (Azure's default applies)
   */
  sampling?: DiagnosticSampling;
  /**
   * Headers and body bytes to log for requests/responses between client and gateway.
   * @default not set (Azure's default applies)
   */
  frontend?: DiagnosticPipelineSettings;
  /**
   * Headers and body bytes to log for requests/responses between gateway and backend.
   * @default not set (Azure's default applies)
   */
  backend?: DiagnosticPipelineSettings;
  /**
   * Whether to log the client IP address.
   * @default false
   */
  logClientIp?: boolean;
  /**
   * Correlation header protocol used for Application Insights.
   * @default not set (Azure's default applies)
   */
  httpCorrelationProtocol?: DiagnosticCorrelationProtocol;
  /**
   * Verbosity applied to traces emitted by `trace` policies.
   * @default not set (Azure's default applies)
   */
  verbosity?: DiagnosticVerbosity;
  /**
   * Operation name format in Application Insights telemetry.
   * @default "Name"
   */
  operationNameFormat?: DiagnosticOperationNameFormat;
  /**
   * Emit custom metrics via the `emit-metric` policy (Application Insights only).
   * @default not set (Azure's default applies)
   */
  metrics?: boolean;
}

export interface WorkspaceApiDiagnostic extends Resource<
  "Azure.ApiManagement.WorkspaceApiDiagnostic",
  WorkspaceApiDiagnosticProps,
  {
    /** Diagnostic identifier (`applicationinsights` or `azuremonitor`). */
    diagnosticName: string;
    /** ARM resource ID of the diagnostic. */
    diagnosticId: string;
    /** Identifier of the API the diagnostic applies to. */
    apiName: string;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Workspace that holds the entity. */
    workspaceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** ARM resource ID of the target logger. */
    loggerId: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link ApiDiagnostic}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 * The ARM type is
 * `Microsoft.ApiManagement/service/workspaces/apis/diagnostics`.
 *
 * Diagnostic settings of a single API in an API Management service. It
 * overrides the service-wide {@link Diagnostic} for that API and sends its
 * request telemetry to a {@link Logger}.
 *
 * :::caution
 * Changing `serviceName`, `workspaceName`, `apiName`, `name`, or
 * `resourceGroup` replaces the diagnostic.
 *
 * Workspaces need a BasicV2, StandardV2, or Premium service ("Method not
 * allowed in Consumption pricing tier").
 * :::
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-app-insights
 *
 * ### Logging One API
 * **Example:** Log every request of an API to Application Insights
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   sku: { name: "BasicV2", capacity: 1 },
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const workspace = yield* Azure.ApiManagement.Workspace("payments", {
 *   serviceName: apim.serviceName,
 * });
 * const api = yield* Azure.ApiManagement.WorkspaceApi("orders", {
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   path: "orders",
 *   serviceUrl: "https://orders.example.com",
 * });
 * const logger = yield* Azure.ApiManagement.WorkspaceLogger("insights", {
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   loggerType: "applicationInsights",
 *   credentials: {
 *     connectionString: yield* Config.redacted("APPINSIGHTS_CONNECTION_STRING"),
 *   },
 * });
 * yield* Azure.ApiManagement.WorkspaceApiDiagnostic("orders-insights", {
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   apiName: api.apiName,
 *   loggerId: logger.loggerId,
 *   alwaysLog: "allErrors",
 *   sampling: { samplingType: "fixed", percentage: 100 },
 *   verbosity: "verbose",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceApiDiagnostic = GroupedResource<WorkspaceApiDiagnostic>(
  "Azure.ApiManagement.WorkspaceApiDiagnostic",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  apiName: string;
  diagnosticName: string;
}

const desiredOf = (news: WorkspaceApiDiagnosticProps) => ({
  alwaysLog: news.alwaysLog,
  sampling: news.sampling,
  frontend: news.frontend,
  backend: news.backend,
  logClientIp: news.logClientIp ?? false,
  httpCorrelationProtocol: news.httpCorrelationProtocol,
  verbosity: news.verbosity,
  operationNameFormat: news.operationNameFormat ?? "Name",
  metrics: news.metrics,
});

export const WorkspaceApiDiagnosticProvider = () =>
  Provider.succeed(WorkspaceApiDiagnostic, {
    stables: [
      "diagnosticName",
      "diagnosticId",
      "apiName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceApiDiagnosticProps,
      WorkspaceApiDiagnostic["Attributes"],
      Key,
      apim.GetWorkspaceApiDiagnosticResponse
    >({
      label: (key) => `API Management diagnostic ${key.diagnosticName} of API ${key.apiName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          workspaceName: props.workspaceName,
          apiName: props.apiName,
          diagnosticName: props.name ?? "applicationinsights",
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceApiDiagnostic({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          apiId: key.apiName,
          diagnosticId: key.diagnosticName,
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceApiDiagnosticCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          apiId: key.apiName,
          diagnosticId: key.diagnosticName,
          properties: { ...desiredOf(news), loggerId: news.loggerId },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceApiDiagnostic({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          apiId: key.apiName,
          diagnosticId: key.diagnosticName,
        }),
      inSync: (news, observed) =>
        sameName(loggerNameOf(observed.properties?.loggerId), loggerNameOf(news.loggerId)) &&
        subsetMatches(desiredOf(news), observed.properties),
      toAttrs: (_subscriptionId, key, observed) => ({
        ...key,
        diagnosticId: observed.id ?? "",
        loggerId: observed.properties?.loggerId ?? "",
      }),
    }),
  });
