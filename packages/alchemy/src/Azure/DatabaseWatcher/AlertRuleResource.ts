import * as databasewatcher from "@distilled.cloud/azure/databasewatcher";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createWatcherChildName } from "./common.ts";

export interface AlertRuleResourceProps {
  /** Resource group of the watcher. Changing it replaces the link. */
  resourceGroup: string;
  /** Name of the watcher. Changing it replaces the link. */
  watcher: string;
  /**
   * Name of the alert rule link. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the link.
   */
  name?: string;
  /**
   * ARM resource ID of the Azure Monitor alert rule
   * (`Microsoft.Insights/scheduledQueryRules`). Changing it replaces the
   * link.
   */
  alertRuleResourceId: string;
  /**
   * How the alert rule was created. Changing it replaces the link.
   * @default "None"
   */
  createdWithProperties?: "CreatedWithActionGroup" | "None";
  /**
   * Creation time of the alert rule (ISO 8601). Changing it replaces the
   * link.
   * @default "2025-01-01T00:00:00Z"
   */
  creationTime?: string;
  /** ID of the watcher alert rule template the rule was created from. Changing it replaces the link. */
  alertRuleTemplateId: string;
  /** Version of the alert rule template. Changing it replaces the link. */
  alertRuleTemplateVersion: string;
}

export interface AlertRuleResource extends Resource<
  "Azure.DatabaseWatcher.AlertRuleResource",
  AlertRuleResourceProps,
  {
    /** Name of the alert rule link. */
    alertRuleResourceName: string;
    /** Name of the watcher. */
    watcherName: string;
    /** Resource group of the watcher. */
    resourceGroup: string;
    /** ARM resource ID of the alert rule link. */
    id: string;
    /** ARM resource ID of the linked alert rule. */
    alertRuleResourceId: string;
    /** Template ID of the linked alert rule. */
    alertRuleTemplateId: string;
    /** Template version of the linked alert rule. */
    alertRuleTemplateVersion: string;
    /** Provisioning state of the link. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Links an Azure Monitor alert rule to a database watcher so the watcher
 * lists it among its alerts. The alert rule itself is an
 * `Azure.Monitor.ScheduledQueryRule` created from a watcher alert
 * template.
 *
 * Links cannot be tagged; Alchemy owns a link it created or whose name it
 * generated. All properties are immutable.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database-watcher-alerts
 *
 * ### Linking an Alert Rule
 * **Example:** Register a scheduled query rule with a watcher
 * ```typescript
 * yield* Azure.DatabaseWatcher.AlertRuleResource("high-cpu", {
 *   resourceGroup: group.resourceGroupName,
 *   watcher: watcher.watcherName,
 *   alertRuleResourceId: rule.scheduledQueryRuleId,
 *   alertRuleTemplateId: "SqlDb-HighCpuUtilization",
 *   alertRuleTemplateVersion: "1.0",
 * });
 * ```
 *
 * @resource
 */
export const AlertRuleResource = Resource<AlertRuleResource>(
  "Azure.DatabaseWatcher.AlertRuleResource",
);

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  watcherName: string,
  alertRuleResourceName: string,
) =>
  orUndefinedIfNotFound(
    databasewatcher.GetAlertRuleResource({
      subscriptionId,
      resourceGroupName,
      watcherName,
      alertRuleResourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  watcherName: string,
  name: string,
  link: databasewatcher.GetAlertRuleResourceResponse,
): AlertRuleResource["Attributes"] => ({
  alertRuleResourceName: name,
  watcherName,
  resourceGroup,
  id: link.id ?? "",
  alertRuleResourceId: link.properties?.alertRuleResourceId ?? "",
  alertRuleTemplateId: link.properties?.alertRuleTemplateId ?? "",
  alertRuleTemplateVersion: link.properties?.alertRuleTemplateVersion ?? "",
  provisioningState: link.properties?.provisioningState,
});

const lower = (value: string | undefined) => (value ?? "").toLowerCase();

export const AlertRuleResourceProvider = () =>
  Provider.succeed(AlertRuleResource, {
    stables: ["alertRuleResourceName", "watcherName", "resourceGroup", "id"],

    // Links live inside a watcher; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.watcher) !== lower(output.watcherName) ||
        (news.name !== undefined &&
          news.name !== output.alertRuleResourceName) ||
        lower(news.alertRuleResourceId) !== lower(output.alertRuleResourceId) ||
        news.alertRuleTemplateId !== output.alertRuleTemplateId ||
        news.alertRuleTemplateVersion !== output.alertRuleTemplateVersion ||
        (olds !== undefined &&
          ((news.createdWithProperties ?? "None") !==
            (olds.createdWithProperties ?? "None") ||
            news.creationTime !== olds.creationTime))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const watcherName = output?.watcherName ?? olds?.watcher;
      if (resourceGroup === undefined || watcherName === undefined) {
        return undefined;
      }
      const generated = yield* createWatcherChildName(id);
      const name = output?.alertRuleResourceName ?? olds?.name ?? generated;
      const observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        watcherName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, watcherName, name, observed);
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DatabaseWatcher");
      const { resourceGroup, watcher } = news;
      const name =
        news.name ??
        output?.alertRuleResourceName ??
        (yield* createWatcherChildName(id));
      const get = getLink(subscriptionId, resourceGroup, watcher, name);

      // Observe.
      const observed = yield* get;

      // Ensure. Every property is immutable (changes replace the link), so
      // an existing link only needs re-writing when it drifted.
      if (
        observed === undefined ||
        lower(observed.properties?.alertRuleResourceId) !==
          lower(news.alertRuleResourceId) ||
        observed.properties?.alertRuleTemplateId !== news.alertRuleTemplateId ||
        observed.properties?.alertRuleTemplateVersion !==
          news.alertRuleTemplateVersion
      ) {
        yield* databasewatcher.AlertRuleResourcesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          watcherName: watcher,
          alertRuleResourceName: name,
          properties: {
            alertRuleResourceId: news.alertRuleResourceId,
            createdWithProperties: news.createdWithProperties ?? "None",
            creationTime: news.creationTime ?? "2025-01-01T00:00:00Z",
            alertRuleTemplateId: news.alertRuleTemplateId,
            alertRuleTemplateVersion: news.alertRuleTemplateVersion,
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `database watcher alert rule link ${name}`,
        get,
        (l) => l.properties?.provisioningState,
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(resourceGroup, watcher, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        databasewatcher.DeleteAlertRuleResource({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          watcherName: output.watcherName,
          alertRuleResourceName: output.alertRuleResourceName,
        }),
      );
      yield* waitUntilGone(
        `database watcher alert rule link ${output.alertRuleResourceName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.watcherName,
          output.alertRuleResourceName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.DatabaseWatcher.Watcher"] },
  });
