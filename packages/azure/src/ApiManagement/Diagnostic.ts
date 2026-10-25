import * as apim from "@distilled.cloud/azure/apimanagement";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { isParentOwned, sameName, subsetMatches } from "./Common.ts";

export type DiagnosticSampling = apim.SamplingSettings;
export type DiagnosticPipelineSettings = apim.PipelineDiagnosticSettings;
export type DiagnosticVerbosity = apim.DiagnosticContractPropertiesVerbosity;
export type DiagnosticCorrelationProtocol =
  apim.DiagnosticContractPropertiesHttpCorrelationProtocol;
export type DiagnosticOperationNameFormat = apim.DiagnosticContractPropertiesOperationNameFormat;

export interface DiagnosticProps {
  /** Resource group of the API Management service. Changing it replaces the diagnostic. */
  resourceGroup: string;
  /** API Management service the diagnostic applies to. Changing it replaces the diagnostic. */
  serviceName: string;
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

export interface Diagnostic extends Resource<
  "Azure.ApiManagement.Diagnostic",
  DiagnosticProps,
  {
    /** Diagnostic identifier (`applicationinsights` or `azuremonitor`). */
    diagnosticName: string;
    /** ARM resource ID of the diagnostic. */
    diagnosticId: string;
    /** API Management service the diagnostic applies to. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** ARM resource ID of the target logger. */
    loggerId: string;
  },
  never,
  Providers
> {}

/**
 * Service-wide diagnostic settings of an API Management service — sends
 * request telemetry for every API to a {@link Logger}.
 * The ARM type is `Microsoft.ApiManagement/service/diagnostics`.
 *
 * :::caution
 * Changing `serviceName`, `name`, or `resourceGroup` replaces the
 * diagnostic.
 * :::
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-app-insights
 *
 * ### Sending Telemetry to Application Insights
 * **Example:** Log every API with 50% sampling
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const logger = yield* Azure.ApiManagement.Logger("insights", {
 *   serviceName: apim.serviceName,
 *   loggerType: "applicationInsights",
 *   credentials: { connectionString: yield* Config.redacted("APPINSIGHTS_CONNECTION_STRING") },
 * });
 * yield* Azure.ApiManagement.Diagnostic("insights", {
 *   serviceName: apim.serviceName,
 *   loggerId: logger.loggerId,
 *   alwaysLog: "allErrors",
 *   sampling: { samplingType: "fixed", percentage: 50 },
 *   verbosity: "information",
 * });
 * ```
 *
 * @resource
 */
export const Diagnostic = GroupedResource<Diagnostic>("Azure.ApiManagement.Diagnostic");

const getDiagnostic = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  diagnosticId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetDiagnostic({
      subscriptionId,
      resourceGroupName,
      serviceName,
      diagnosticId,
    }),
  );

/** Logger name of a logger ARM id (GET may return a service-relative id). */
const loggerNameOf = (loggerId: string | undefined) => loggerId?.split("/loggers/")[1];

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  diagnostic: apim.GetDiagnosticResponse,
): Diagnostic["Attributes"] => ({
  diagnosticName: name,
  diagnosticId: diagnostic.id ?? "",
  serviceName,
  resourceGroup,
  loggerId: diagnostic.properties?.loggerId ?? "",
});

export const DiagnosticProvider = () =>
  Provider.succeed(Diagnostic, {
    stables: ["diagnosticName", "diagnosticId", "serviceName", "resourceGroup"],

    // Diagnostics live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        !sameName(news.name ?? "applicationinsights", output.diagnosticName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const name = output?.diagnosticName ?? olds?.name ?? "applicationinsights";
      const observed = yield* getDiagnostic(subscriptionId, resourceGroup, serviceName, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, name, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name = news.name ?? "applicationinsights";
      const desired: Omit<apim.DiagnosticContractProperties, "loggerId"> = {
        alwaysLog: news.alwaysLog,
        sampling: news.sampling,
        frontend: news.frontend,
        backend: news.backend,
        logClientIp: news.logClientIp ?? false,
        httpCorrelationProtocol: news.httpCorrelationProtocol,
        verbosity: news.verbosity,
        operationNameFormat: news.operationNameFormat ?? "Name",
        metrics: news.metrics,
      };

      // Observe, then create or sync with one upsert when anything differs.
      const observed = yield* getDiagnostic(subscriptionId, resourceGroup, serviceName, name);
      const inSync =
        observed !== undefined &&
        sameName(loggerNameOf(observed.properties?.loggerId), loggerNameOf(news.loggerId)) &&
        subsetMatches(desired, observed.properties);
      const current =
        inSync && observed !== undefined
          ? observed
          : yield* apim.DiagnosticCreateOrUpdate({
              subscriptionId,
              resourceGroupName: resourceGroup,
              serviceName,
              diagnosticId: name,
              properties: { ...desired, loggerId: news.loggerId },
            });
      return toAttrs(resourceGroup, serviceName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteDiagnostic({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          diagnosticId: output.diagnosticName,
        }),
      );
      yield* waitUntilGone(
        `API Management diagnostic ${output.diagnosticName}`,
        getDiagnostic(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.diagnosticName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
