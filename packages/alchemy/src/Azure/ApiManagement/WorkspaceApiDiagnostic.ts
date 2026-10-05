import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
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
  /** Message types that bypass sampling (`allErrors`). */
  alwaysLog?: "allErrors";
  /** Sampling settings, e.g. `{ samplingType: "fixed", percentage: 50 }`. */
  sampling?: DiagnosticSampling;
  /** Headers and body bytes to log for requests/responses between client and gateway. */
  frontend?: DiagnosticPipelineSettings;
  /** Headers and body bytes to log for requests/responses between gateway and backend. */
  backend?: DiagnosticPipelineSettings;
  /**
   * Whether to log the client IP address.
   * @default false
   */
  logClientIp?: boolean;
  /** Correlation header protocol used for Application Insights. */
  httpCorrelationProtocol?: DiagnosticCorrelationProtocol;
  /** Verbosity applied to traces emitted by `trace` policies. */
  verbosity?: DiagnosticVerbosity;
  /**
   * Operation name format in Application Insights telemetry.
   * @default "Name"
   */
  operationNameFormat?: DiagnosticOperationNameFormat;
  /** Emit custom metrics via the `emit-metric` policy (Application Insights only). */
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
 *
 * Diagnostic settings of a single API in an API Management service. It
 * overrides the service-wide {@link Diagnostic} for that API and sends its
 * request telemetry to a {@link Logger}.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-app-insights
 *
 * ### Logging One API
 * **Example:** Log every request of an API to Application Insights
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceApiDiagnostic("orders-insights", {
 *   resourceGroup: group.resourceGroupName,
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
export const WorkspaceApiDiagnostic = Resource<WorkspaceApiDiagnostic>(
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
      label: (key) =>
        `API Management diagnostic ${key.diagnosticName} of API ${key.apiName}`,
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
        sameName(
          loggerNameOf(observed.properties?.loggerId),
          loggerNameOf(news.loggerId),
        ) && subsetMatches(desiredOf(news), observed.properties),
      toAttrs: (_subscriptionId, key, observed) => ({
        ...key,
        diagnosticId: observed.id ?? "",
        loggerId: observed.properties?.loggerId ?? "",
      }),
    }),
  });
