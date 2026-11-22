import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createEntityName, sameName } from "./Common.ts";
import { entityLifecycle, sameSecrets, reveal } from "./Entity.ts";
import type { Logger, LoggerProps } from "./Logger.ts";

export interface WorkspaceLoggerProps extends LoggerProps {
  /** Workspace that holds the logger (`Workspace.workspaceName`). Changing it replaces the logger. */
  workspaceName: string;
}

export interface WorkspaceLogger extends Resource<
  "Azure.ApiManagement.WorkspaceLogger",
  WorkspaceLoggerProps,
  Logger["Attributes"] & {
    /** Workspace that holds the logger. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link Logger}: a logger inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link Logger} plus `workspaceName`.
 * The ARM type is `Microsoft.ApiManagement/service/workspaces/loggers`.
 *
 * :::caution
 * Changing `workspaceName`, `serviceName`, `name`, `loggerType`, or
 * `resourceGroup` replaces the logger.
 *
 * Workspaces need a BasicV2, StandardV2, or Premium service ("Method not
 * allowed in Consumption pricing tier").
 * :::
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Loggers
 * **Example:** Application Insights logger
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   sku: { name: "BasicV2", capacity: 1 },
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const workspace = yield* Azure.ApiManagement.Workspace("payments", {
 *   serviceName: apim.serviceName,
 * });
 * yield* Azure.ApiManagement.WorkspaceLogger("insights", {
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   loggerType: "applicationInsights",
 *   credentials: { connectionString: yield* Config.redacted("APPINSIGHTS_CONNECTION_STRING") },
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceLogger = GroupedResource<WorkspaceLogger>(
  "Azure.ApiManagement.WorkspaceLogger",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  loggerName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  loggerId: key.loggerName,
});

export const WorkspaceLoggerProvider = () =>
  Provider.succeed(WorkspaceLogger, {
    stables: ["loggerName", "loggerId", "serviceName", "workspaceName", "resourceGroup"],
    ...entityLifecycle<
      WorkspaceLoggerProps,
      WorkspaceLogger["Attributes"],
      Key,
      apim.GetWorkspaceLoggerResponse
    >({
      label: (key) => `API Management workspace logger ${key.loggerName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            loggerName: props.name ?? output?.loggerName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceLogger({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceLoggerCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: {
            loggerType: news.loggerType,
            description: news.description,
            credentials:
              news.credentials === undefined
                ? undefined
                : Object.fromEntries(
                    Object.entries(news.credentials).map(([k, v]) => [k, reveal(v)]),
                  ),
            isBuffered: news.isBuffered ?? true,
            resourceId: news.resourceId,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceLogger({
          ...where(subscriptionId, key),
        }),
      // GET masks credentials, so the previous props are the baseline.
      inSync: (news, observed, olds) => {
        const props = observed.properties;
        return (
          props !== undefined &&
          (news.credentials === undefined ||
            (olds !== undefined && sameSecrets(news.credentials, olds.credentials))) &&
          sameName(props.loggerType, news.loggerType) &&
          (news.description === undefined || props.description === news.description) &&
          (props.isBuffered ?? true) === (news.isBuffered ?? true) &&
          (news.resourceId === undefined || sameName(props.resourceId, news.resourceId))
        );
      },
      // The logger type cannot change in place.
      replaceOn: (news, _olds, output) =>
        output.loggerType !== "" && !sameName(news.loggerType, output.loggerType),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        loggerName: key.loggerName,
        loggerId: observed.id ?? "",
        loggerType: observed.properties?.loggerType ?? "",
      }),
    }),
  });
