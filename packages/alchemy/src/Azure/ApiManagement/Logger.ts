import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, isParentOwned, sameName } from "./Common.ts";

export type LoggerType = apim.LoggerContractPropertiesLoggerType;

export interface LoggerProps {
  /** Resource group of the API Management service. Changing it replaces the logger. */
  resourceGroup: string;
  /** API Management service that holds the logger. Changing it replaces the logger. */
  serviceName: string;
  /**
   * Logger identifier (1-80 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the logger.
   */
  name?: string;
  /**
   * Event sink. `azureMonitor` is not available on the Consumption tier.
   * Changing it replaces the logger.
   */
  loggerType: LoggerType;
  /**
   * Sink credentials: `instrumentationKey` or `connectionString` for
   * Application Insights; `name` plus `connectionString` (or
   * `identityClientId` plus `endpointAddress`) for Event Hubs. APIM stores
   * them in a generated named value, so changes are detected against the
   * previously deployed props rather than the cloud.
   */
  credentials?: Record<string, string | Redacted.Redacted<string>>;
  /** Description of the logger. */
  description?: string;
  /**
   * Whether records are buffered before publishing.
   * @default true
   */
  isBuffered?: boolean;
  /** ARM resource ID of the log target (Application Insights component or Event Hub). */
  resourceId?: string;
}

export interface Logger extends Resource<
  "Azure.ApiManagement.Logger",
  LoggerProps,
  {
    /** Logger identifier. */
    loggerName: string;
    /** ARM resource ID of the logger; pass it as a diagnostic's `loggerId`. */
    loggerId: string;
    /** API Management service that holds the logger. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Event sink type. */
    loggerType: string;
  },
  never,
  Providers
> {}

/**
 * An API Management logger — an event sink (Application Insights, Event
 * Hubs, or Azure Monitor) that diagnostics and the `log-to-eventhub`
 * policy write to.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-app-insights
 *
 * ### Creating a Logger
 * **Example:** Application Insights logger
 * ```typescript
 * const logger = yield* Azure.ApiManagement.Logger("insights", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   loggerType: "applicationInsights",
 *   credentials: {
 *     connectionString: Redacted.make(process.env.APPINSIGHTS_CONNECTION_STRING!),
 *   },
 * });
 * ```
 *
 * **Example:** Event Hubs logger
 * ```typescript
 * const logger = yield* Azure.ApiManagement.Logger("events", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   loggerType: "azureEventHub",
 *   credentials: {
 *     name: hub.eventHubName,
 *     connectionString: Redacted.make(process.env.EVENTHUB_CONNECTION_STRING!),
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Logger = Resource<Logger>("Azure.ApiManagement.Logger");

const getLogger = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  loggerId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetLogger({ subscriptionId, resourceGroupName, serviceName, loggerId }),
  );

const revealCredentials = (
  credentials: LoggerProps["credentials"],
): Record<string, string> | undefined =>
  credentials === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(credentials).map(([key, value]) => [
          key,
          typeof value === "string" ? value : Redacted.value(value),
        ]),
      );

const sameCredentials = (
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
) => {
  const left = Object.entries(a ?? {});
  return (
    left.length === Object.keys(b ?? {}).length &&
    left.every(([key, value]) => b?.[key] === value)
  );
};

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  logger: apim.GetLoggerResponse,
): Logger["Attributes"] => ({
  loggerName: name,
  loggerId: logger.id ?? "",
  serviceName,
  resourceGroup,
  loggerType: logger.properties?.loggerType ?? "",
});

export const LoggerProvider = () =>
  Provider.succeed(Logger, {
    stables: ["loggerName", "loggerId", "serviceName", "resourceGroup"],

    // Loggers live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        (news.name !== undefined && !sameName(news.name, output.loggerName)) ||
        (output.loggerType !== "" &&
          !sameName(news.loggerType, output.loggerType))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const name =
        output?.loggerName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getLogger(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, name, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name =
        news.name ?? output?.loggerName ?? (yield* createEntityName(id));
      const credentials = revealCredentials(news.credentials);

      const observed = yield* getLogger(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      const props = observed?.properties;
      // GET masks credentials as `{{Logger-Credentials--...}}`, so the
      // previous props are the only baseline; without them (adoption) the
      // credentials are always sent.
      const credentialsInSync =
        credentials === undefined ||
        (olds !== undefined &&
          sameCredentials(credentials, revealCredentials(olds.credentials)));
      const inSync =
        props !== undefined &&
        credentialsInSync &&
        sameName(props.loggerType, news.loggerType) &&
        (news.description === undefined ||
          props.description === news.description) &&
        (props.isBuffered ?? true) === (news.isBuffered ?? true) &&
        (news.resourceId === undefined ||
          sameName(props.resourceId, news.resourceId));

      const current =
        inSync && observed !== undefined
          ? observed
          : yield* apim.LoggerCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            serviceName,
            loggerId: name,
            properties: {
              loggerType: news.loggerType,
              description: news.description,
              credentials,
              isBuffered: news.isBuffered ?? true,
              resourceId: news.resourceId,
            },
          });
      return toAttrs(resourceGroup, serviceName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteLogger({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          loggerId: output.loggerName,
        }),
      );
      yield* waitUntilGone(
        `API Management logger ${output.loggerName}`,
        getLogger(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.loggerName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
