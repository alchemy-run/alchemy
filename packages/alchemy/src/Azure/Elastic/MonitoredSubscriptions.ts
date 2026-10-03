import * as elastic from "@distilled.cloud/azure/elastic";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  canonicalJson,
  DEFAULT_CONFIGURATION,
  type ElasticLogRules,
  isMonitorOwnedByStack,
  type MonitorChildProps,
  normalizeLogRules,
  sameName,
} from "./common.ts";

/** An Azure subscription the monitor's Elastic deployment monitors. */
export interface ElasticMonitoredSubscription {
  /** ID of the Azure subscription (requires Owner on it). */
  subscriptionId: string;
  /** Which logs of the subscription are sent to Elastic. */
  logRules?: ElasticLogRules;
}

export interface MonitoredSubscriptionsProps extends MonitorChildProps {
  /**
   * Additional Azure subscriptions monitored by the monitor's Elastic
   * deployment. The monitor's own subscription is always monitored.
   */
  subscriptions: ElasticMonitoredSubscription[];
}

export interface MonitoredSubscriptions extends Resource<
  "Azure.Elastic.MonitoredSubscriptions",
  MonitoredSubscriptionsProps,
  {
    /** Name of the Elastic monitor. */
    monitor: string;
    /** Resource group of the monitor. */
    resourceGroup: string;
    /** Name of the configuration (always `default`). */
    configurationName: string;
    /** ARM resource ID of the configuration. */
    configurationId: string;
    /** Observed monitored subscriptions and their monitoring status. */
    subscriptions: {
      /** ID of the Azure subscription. */
      subscriptionId: string;
      /** Monitoring status, e.g. `Active`, `InProgress`, `Failed`. */
      status: string | undefined;
      /** Why monitoring failed, when `status` is `Failed`. */
      error: string | undefined;
    }[];
  },
  never,
  Providers
> {}

/**
 * Additional Azure subscriptions monitored by an Elastic monitor
 * (`Microsoft.Elastic/monitors/monitoredSubscriptions`, singleton
 * `default`). Lets one Elastic deployment collect logs from several
 * subscriptions; the deploying identity needs Owner on each of them.
 *
 * ### Monitoring More Subscriptions
 * **Example:** Monitor a second subscription
 * ```typescript
 * const monitored = yield* Azure.Elastic.MonitoredSubscriptions("monitored", {
 *   resourceGroup: group.resourceGroupName,
 *   monitor: monitor.monitorName,
 *   subscriptions: [
 *     {
 *       subscriptionId: "00000000-0000-0000-0000-000000000000",
 *       logRules: { sendSubscriptionLogs: true, sendActivityLogs: true },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const MonitoredSubscriptions = Resource<MonitoredSubscriptions>(
  "Azure.Elastic.MonitoredSubscriptions",
);

export class ElasticMonitoredSubscriptionsTimedOut extends Data.TaggedError(
  "Azure.Elastic.MonitoredSubscriptionsTimedOut",
)<{
  readonly monitor: string;
  readonly message: string;
}> {}

const getConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) =>
  orUndefinedIfNotFound(
    elastic.GetMonitoredSubscription({
      subscriptionId,
      resourceGroupName,
      monitorName,
      configurationName: DEFAULT_CONFIGURATION,
    }),
  );

/** The configuration, or `undefined` when missing or empty. */
const getNonEmptyConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) =>
  getConfiguration(subscriptionId, resourceGroupName, monitorName).pipe(
    Effect.map((config) =>
      (config?.properties?.monitoredSubscriptionList ?? []).length > 0
        ? config
        : undefined,
    ),
  );

const PENDING = new Set(["InProgress", "Deleting"]);

const isPending = (
  config: elastic.GetMonitoredSubscriptionResponse | undefined,
) =>
  (config?.properties?.monitoredSubscriptionList ?? []).some(
    (entry) => entry.status !== undefined && PENDING.has(entry.status),
  );

/** Poll until no monitored subscription is still being added or removed. */
const waitForSettled = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) =>
  getConfiguration(subscriptionId, resourceGroupName, monitorName).pipe(
    Effect.repeat({
      until: (config) => !isPending(config),
      schedule: Schedule.spaced("10 seconds"),
      times: 36,
    }),
    Effect.flatMap((config) =>
      isPending(config)
        ? Effect.fail(
            new ElasticMonitoredSubscriptionsTimedOut({
              monitor: monitorName,
              message: `Monitored subscriptions of ${monitorName} are still changing after 6 minutes`,
            }),
          )
        : Effect.succeed(config),
    ),
  );

const toAttrs = (
  resourceGroup: string,
  monitor: string,
  observed: elastic.GetMonitoredSubscriptionResponse | undefined,
): MonitoredSubscriptions["Attributes"] => ({
  monitor,
  resourceGroup,
  configurationName: DEFAULT_CONFIGURATION,
  configurationId: observed?.id ?? "",
  subscriptions: (observed?.properties?.monitoredSubscriptionList ?? []).map(
    (entry) => ({
      subscriptionId: entry.subscriptionId,
      status: entry.status,
      error: entry.error,
    }),
  ),
});

export const MonitoredSubscriptionsProvider = () =>
  Provider.succeed(MonitoredSubscriptions, {
    stables: ["monitor", "resourceGroup", "configurationName"],

    // The configuration lives and dies with its monitor, which `list` covers.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.monitor, output.monitor)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const monitor = output?.monitor ?? olds?.monitor;
      if (resourceGroup === undefined || monitor === undefined) {
        return undefined;
      }
      const observed = yield* getNonEmptyConfiguration(
        subscriptionId,
        resourceGroup,
        monitor,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, monitor, observed);
      return (yield* isMonitorOwnedByStack(
        subscriptionId,
        resourceGroup,
        monitor,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Elastic");
      const { resourceGroup, monitor } = news;
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        monitorName: monitor,
        configurationName: DEFAULT_CONFIGURATION,
      };

      // Observe.
      const observed = yield* getConfiguration(
        subscriptionId,
        resourceGroup,
        monitor,
      );
      const observedList =
        observed?.properties?.monitoredSubscriptionList ?? [];
      const observedById = new Map(
        observedList.map((entry) => [entry.subscriptionId.toLowerCase(), entry]),
      );
      const desiredIds = new Set(
        news.subscriptions.map((entry) => entry.subscriptionId.toLowerCase()),
      );

      // Desired entries that are missing, failed, or whose rules drifted.
      const toAdd = news.subscriptions
        .filter((entry) => {
          const current = observedById.get(entry.subscriptionId.toLowerCase());
          return (
            current === undefined ||
            current.status === "Failed" ||
            canonicalJson(normalizeLogRules(current.tagRules?.logRules)) !==
              canonicalJson(normalizeLogRules(entry.logRules))
          );
        })
        .map((entry) => ({
          subscriptionId: entry.subscriptionId,
          tagRules: { logRules: normalizeLogRules(entry.logRules) },
        }));
      const toRemove = observedList.filter(
        (entry) => !desiredIds.has(entry.subscriptionId.toLowerCase()),
      );

      // Ensure: the first write creates the singleton.
      const addRequest = {
        ...request,
        properties: {
          operation: "AddBegin",
          monitoredSubscriptionList: toAdd,
        },
      };
      if (observed === undefined && toAdd.length > 0) {
        yield* elastic.UpdateMonitoredSubscriptionsCreateor(addRequest);
      } else if (toAdd.length > 0) {
        yield* elastic.UpdateMonitoredSubscription(addRequest);
      }

      // Sync: remove subscriptions no longer desired.
      if (toRemove.length > 0) {
        yield* elastic.UpdateMonitoredSubscription({
          ...request,
          properties: {
            operation: "DeleteBegin",
            monitoredSubscriptionList: toRemove.map((entry) => ({
              subscriptionId: entry.subscriptionId,
            })),
          },
        });
      }

      const final =
        toAdd.length > 0 || toRemove.length > 0
          ? yield* waitForSettled(subscriptionId, resourceGroup, monitor)
          : observed;
      return toAttrs(resourceGroup, monitor, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        elastic.DeleteMonitoredSubscription({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          monitorName: output.monitor,
          configurationName: DEFAULT_CONFIGURATION,
        }),
      );
      yield* waitUntilGone(
        `Elastic monitored subscriptions of ${output.monitor}`,
        getNonEmptyConfiguration(
          subscriptionId,
          output.resourceGroup,
          output.monitor,
        ),
        { interval: "10 seconds", times: 36 },
      );
    }),

    nuke: { dependsOn: ["Azure.Elastic.Monitor"] },
  });
