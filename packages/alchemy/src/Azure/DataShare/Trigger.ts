import * as datashare from "@distilled.cloud/azure/datashare";
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
import {
  accountOwnedByStack,
  createChildName,
  immutableChanged,
  kindProperties,
  stringProp,
} from "./internal.ts";
import type { RecurrenceInterval } from "./SynchronizationSetting.ts";

export type SynchronizationMode = "Incremental" | "FullSync";

export interface TriggerProps {
  /** Resource group of the consumer Data Share account. Changing it replaces the trigger. */
  resourceGroup: string;
  /** Consumer Data Share account. Changing it replaces the trigger. */
  account: string;
  /** Share subscription the trigger snapshots. Changing it replaces the trigger. */
  shareSubscription: string;
  /**
   * Trigger name: letters, digits, and `_`, starting with a letter. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the trigger.
   */
  name?: string;
  /**
   * How often snapshots run. Must match a synchronization setting the
   * provider offers on the share. Changing it replaces the trigger.
   */
  recurrenceInterval: RecurrenceInterval;
  /**
   * ISO 8601 start time of the schedule, e.g. `2026-01-01T06:00:00Z`.
   * Changing it replaces the trigger.
   */
  synchronizationTime: string;
  /**
   * `Incremental` copies only changes since the last snapshot; `FullSync`
   * copies everything. Changing it replaces the trigger.
   * @default "Incremental"
   */
  synchronizationMode?: SynchronizationMode;
}

export interface Trigger extends Resource<
  "Azure.DataShare.Trigger",
  TriggerProps,
  {
    /** Name of the trigger. */
    triggerName: string;
    /** Share subscription the trigger snapshots. */
    shareSubscriptionName: string;
    /** Consumer Data Share account. */
    accountName: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the trigger. */
    triggerId: string;
    /** How often snapshots run. */
    recurrenceInterval: string;
    /** Start time of the schedule as reported by Azure. */
    synchronizationTime: string;
    /** `Incremental` or `FullSync`. */
    synchronizationMode: string;
    /** `Active`, `Inactive`, or `SourceSynchronizationSettingDeleted`. */
    triggerStatus: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string;
  },
  never,
  Providers
> {}

/**
 * A snapshot schedule on an Azure Data Share share subscription (consumer
 * side). The schedule must match a synchronization setting the provider
 * offers on the share; Data Share then copies snapshots into the mapped
 * targets on that schedule. Triggers are immutable; any change replaces
 * them.
 *
 * @see https://learn.microsoft.com/azure/data-share/subscribe-to-data-share#enable-snapshot-schedule
 *
 * ### Scheduling Snapshots
 * **Example:** Daily incremental snapshots
 * ```typescript
 * yield* Azure.DataShare.Trigger("daily", {
 *   resourceGroup: consumerGroup.resourceGroupName,
 *   account: consumerAccount.accountName,
 *   shareSubscription: subscription.shareSubscriptionName,
 *   recurrenceInterval: "Day",
 *   synchronizationTime: "2026-01-01T06:00:00Z",
 * });
 * ```
 *
 * @resource
 */
export const Trigger = Resource<Trigger>("Azure.DataShare.Trigger");

type ObservedTrigger =
  | datashare.GetTriggerResponse
  | datashare.CreateTriggerResponse;

const getTrigger = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  shareSubscriptionName: string,
  triggerName: string,
) =>
  orUndefinedIfNotFound(
    datashare.GetTrigger({
      subscriptionId,
      resourceGroupName,
      accountName,
      shareSubscriptionName,
      triggerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  accountName: string,
  shareSubscriptionName: string,
  name: string,
  trigger: ObservedTrigger,
): Trigger["Attributes"] => {
  const props = kindProperties(trigger);
  return {
    triggerName: name,
    shareSubscriptionName,
    accountName,
    resourceGroup,
    triggerId: trigger.id ?? "",
    recurrenceInterval: stringProp(props, "recurrenceInterval") ?? "",
    synchronizationTime: stringProp(props, "synchronizationTime") ?? "",
    synchronizationMode:
      stringProp(props, "synchronizationMode") ?? "Incremental",
    triggerStatus: stringProp(props, "triggerStatus"),
    provisioningState: stringProp(props, "provisioningState") ?? "Succeeded",
  };
};

export const TriggerProvider = () =>
  Provider.succeed(Trigger, {
    stables: [
      "triggerName",
      "shareSubscriptionName",
      "accountName",
      "resourceGroup",
      "triggerId",
    ],

    // Triggers vanish with their share subscription; the account carries the
    // ownership tags.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Every prop is immutable; an unresolved one comes from an upstream
      // resource being created or replaced.
      const next = news as unknown as Record<keyof TriggerProps, unknown>;
      const ci = { caseInsensitive: true };
      if (
        immutableChanged(next.resourceGroup, output.resourceGroup, ci) ||
        immutableChanged(next.account, output.accountName, ci) ||
        immutableChanged(
          next.shareSubscription,
          output.shareSubscriptionName,
          ci,
        ) ||
        (next.name !== undefined &&
          immutableChanged(next.name, output.triggerName, ci)) ||
        immutableChanged(next.recurrenceInterval, output.recurrenceInterval) ||
        immutableChanged(
          next.synchronizationMode ?? "Incremental",
          output.synchronizationMode,
        ) ||
        (olds !== undefined &&
          (!isResolved(next.synchronizationTime) ||
            Date.parse(next.synchronizationTime as string) !==
              Date.parse(olds.synchronizationTime)))
      ) {
        // A share subscription holds one trigger per kind.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.accountName ?? olds?.account;
      const shareSubscription =
        output?.shareSubscriptionName ?? olds?.shareSubscription;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        shareSubscription === undefined
      ) {
        return undefined;
      }
      const name =
        output?.triggerName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getTrigger(
        subscriptionId,
        resourceGroup,
        account,
        shareSubscription,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        account,
        shareSubscription,
        name,
        observed,
      );
      return (yield* accountOwnedByStack(subscriptionId, resourceGroup, account))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataShare");
      const { resourceGroup, account, shareSubscription } = news;
      const name =
        news.name ?? output?.triggerName ?? (yield* createChildName(id));
      const get = getTrigger(
        subscriptionId,
        resourceGroup,
        account,
        shareSubscription,
        name,
      );

      // Observe. Triggers are immutable: every prop change replaces.
      const observed = yield* get;

      // Ensure. The PUT returns 201 with provisioningState=Creating.
      if (observed === undefined) {
        yield* datashare.CreateTrigger({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: account,
          shareSubscriptionName: shareSubscription,
          triggerName: name,
          kind: "ScheduleBased",
          properties: {
            recurrenceInterval: news.recurrenceInterval,
            synchronizationTime: news.synchronizationTime,
            synchronizationMode: news.synchronizationMode ?? "Incremental",
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `data share trigger ${name}`,
        get,
        (trigger) => stringProp(kindProperties(trigger), "provisioningState"),
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, account, shareSubscription, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datashare.DeleteTrigger({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
          shareSubscriptionName: output.shareSubscriptionName,
          triggerName: output.triggerName,
        }),
      );
      yield* waitUntilGone(
        `data share trigger ${output.triggerName}`,
        getTrigger(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
          output.shareSubscriptionName,
          output.triggerName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.DataShare.Account"],
    },
  });
