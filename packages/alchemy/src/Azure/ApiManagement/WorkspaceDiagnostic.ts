import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Diagnostic, DiagnosticProps } from "./Diagnostic.ts";
import { loggerNameOf, sameName, subsetMatches } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceDiagnosticProps extends DiagnosticProps {
  /** Workspace that holds the diagnostic (`Workspace.workspaceName`). Changing it replaces the diagnostic. */
  workspaceName: string;
}

export interface WorkspaceDiagnostic extends Resource<
  "Azure.ApiManagement.WorkspaceDiagnostic",
  WorkspaceDiagnosticProps,
  Diagnostic["Attributes"] & {
    /** Workspace that holds the diagnostic. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link Diagnostic}: workspace-wide diagnostic settings inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link Diagnostic} plus `workspaceName`.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Telemetry
 * **Example:** Log every workspace API
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceDiagnostic("insights", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   loggerId: logger.loggerId,
 *   sampling: { samplingType: "fixed", percentage: 50 },
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceDiagnostic = Resource<WorkspaceDiagnostic>(
  "Azure.ApiManagement.WorkspaceDiagnostic",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  diagnosticName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  diagnosticId: key.diagnosticName,
});

const desiredOf = (news: WorkspaceDiagnosticProps) => ({
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

export const WorkspaceDiagnosticProvider = () =>
  Provider.succeed(WorkspaceDiagnostic, {
    stables: [
      "diagnosticName",
      "diagnosticId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceDiagnosticProps,
      WorkspaceDiagnostic["Attributes"],
      Key,
      apim.GetWorkspaceDiagnosticResponse
    >({
      label: (key) =>
        `API Management workspace diagnostic ${key.diagnosticName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            diagnosticName: props.name ?? "applicationinsights",
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceDiagnostic({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceDiagnosticCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: { ...desiredOf(news), loggerId: news.loggerId },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceDiagnostic({
          ...where(subscriptionId, key),
        }),
      inSync: (news, observed) =>
        sameName(
          loggerNameOf(observed.properties?.loggerId),
          loggerNameOf(news.loggerId),
        ) && subsetMatches(desiredOf(news), observed.properties),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        diagnosticName: key.diagnosticName,
        diagnosticId: observed.id ?? "",
        loggerId: observed.properties?.loggerId ?? "",
      }),
    }),
  });
