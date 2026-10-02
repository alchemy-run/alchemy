import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
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
import {
  fingerprint,
  isContainerAppOwnedByStack,
  lower,
  matchesDesired,
} from "./common.ts";

export interface LogicAppProps {
  /** Resource group of the container app. Changing it replaces the extension. */
  resourceGroup: string;
  /**
   * Name of the container app hosting the Logic Apps Standard runtime
   * (`kind: "workflowapp"`). Changing it replaces the extension.
   */
  containerApp: string;
  /**
   * Name of the Logic App extension.
   * @default the container app's name
   */
  name?: string;
  /** Logic App extension properties (passed through to Azure as-is). */
  properties?: Record<string, unknown>;
}

export interface LogicApp extends Resource<
  "Azure.ContainerApps.LogicApp",
  LogicAppProps,
  {
    /** Name of the Logic App extension. */
    logicAppName: string;
    /** ARM resource ID of the Logic App extension. */
    logicAppId: string;
    /** Name of the container app. */
    containerApp: string;
    /** Resource group of the container app. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * A Logic App extension on a container app
 * (`Microsoft.App/containerApps/{app}/providers/Microsoft.App/logicApps`) —
 * turns a container app running the Logic Apps Standard runtime into a
 * Logic App whose workflows Azure can list and manage.
 *
 * The extension cannot be tagged; Alchemy treats it as owned when its
 * container app is owned by the same stack and stage.
 *
 * @see https://learn.microsoft.com/azure/logic-apps/create-standard-workflows-azure-container-apps
 *
 * ### Hosting Logic Apps
 * **Example:** Logic App on a workflow container app
 * ```typescript
 * const host = yield* Azure.ContainerApps.ContainerApp("workflows", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   kind: "workflowapp",
 *   // ... Logic Apps Standard runtime image + storage settings
 * });
 * yield* Azure.ContainerApps.LogicApp("logic", {
 *   resourceGroup: group.resourceGroupName,
 *   containerApp: host.containerAppName,
 * });
 * ```
 *
 * @resource
 */
export const LogicApp = Resource<LogicApp>("Azure.ContainerApps.LogicApp");

const getLogicApp = (
  subscriptionId: string,
  resourceGroupName: string,
  containerAppName: string,
  logicAppName: string,
) =>
  orUndefinedIfNotFound(
    app.GetLogicApp({
      subscriptionId,
      resourceGroupName,
      containerAppName,
      logicAppName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  containerApp: string,
  name: string,
  observed: app.GetLogicAppResponse,
): LogicApp["Attributes"] => ({
  logicAppName: name,
  logicAppId: observed.id ?? "",
  containerApp,
  resourceGroup,
});

export const LogicAppProvider = () =>
  Provider.succeed(LogicApp, {
    stables: ["logicAppName", "logicAppId", "containerApp", "resourceGroup"],

    // Lives on a container app; nuke removes it with the app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.containerApp !== output.containerApp ||
        (news.name ?? news.containerApp) !== output.logicAppName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const containerApp = output?.containerApp ?? olds?.containerApp;
      if (resourceGroup === undefined || containerApp === undefined) {
        return undefined;
      }
      const name = output?.logicAppName ?? olds?.name ?? containerApp;
      const observed = yield* getLogicApp(
        subscriptionId,
        resourceGroup,
        containerApp,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, containerApp, name, observed);
      return (yield* isContainerAppOwnedByStack(
        subscriptionId,
        resourceGroup,
        containerApp,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, containerApp } = news;
      const name = news.name ?? containerApp;
      const properties = news.properties ?? {};

      // Observe.
      let observed = yield* getLogicApp(
        subscriptionId,
        resourceGroup,
        containerApp,
        name,
      );

      // Ensure + sync: one synchronous PUT, skipped when nothing changed.
      if (
        observed === undefined ||
        !matchesDesired(properties, observed.properties ?? {}) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(olds.properties ?? {}))
      ) {
        observed = yield* app.LogicAppsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          containerAppName: containerApp,
          logicAppName: name,
          properties,
        });
      }

      return toAttrs(resourceGroup, containerApp, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteLogicApp({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          containerAppName: output.containerApp,
          logicAppName: output.logicAppName,
        }),
      );
      yield* waitUntilGone(
        `logic app ${output.logicAppName}`,
        getLogicApp(
          subscriptionId,
          output.resourceGroup,
          output.containerApp,
          output.logicAppName,
        ),
      );
    }),
  });
