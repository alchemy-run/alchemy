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

export type RecurrenceInterval = "Hour" | "Day";

export interface SynchronizationSettingProps {
  /** Resource group of the Data Share account. Changing it replaces the setting. */
  resourceGroup: string;
  /** Data Share account that offers the share. Changing it replaces the setting. */
  account: string;
  /** Share the schedule applies to. Changing it replaces the setting. */
  share: string;
  /**
   * Setting name: letters, digits, and `_`, starting with a letter. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the setting.
   */
  name?: string;
  /** How often consumers may receive snapshots. Changing it replaces the setting. */
  recurrenceInterval: RecurrenceInterval;
  /**
   * ISO 8601 start time of the schedule, e.g. `2026-01-01T06:00:00Z`.
   * Snapshots run at this time of day (or minute of the hour). Changing it
   * replaces the setting.
   */
  synchronizationTime: string;
}

export interface SynchronizationSetting extends Resource<
  "Azure.DataShare.SynchronizationSetting",
  SynchronizationSettingProps,
  {
    /** Name of the setting. */
    synchronizationSettingName: string;
    /** Share the schedule applies to. */
    shareName: string;
    /** Data Share account that offers the share. */
    accountName: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the setting. */
    synchronizationSettingId: string;
    /** How often consumers may receive snapshots. */
    recurrenceInterval: string;
    /** Start time of the schedule as reported by Azure. */
    synchronizationTime: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string;
  },
  never,
  Providers
> {}

/**
 * A snapshot schedule offered on an Azure Data Share share. Consumers can
 * enable a matching trigger on their share subscription to receive
 * snapshots on this schedule.
 *
 * @see https://learn.microsoft.com/azure/data-share/how-to-share-from-storage
 *
 * ### Offering a Snapshot Schedule
 * **Example:** Daily snapshots at 06:00 UTC
 * ```typescript
 * yield* Azure.DataShare.SynchronizationSetting("daily", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   share: share.shareName,
 *   recurrenceInterval: "Day",
 *   synchronizationTime: "2026-01-01T06:00:00Z",
 * });
 * ```
 *
 * @resource
 */
export const SynchronizationSetting = Resource<SynchronizationSetting>(
  "Azure.DataShare.SynchronizationSetting",
);

type ObservedSetting =
  | datashare.GetSynchronizationSettingsResponse
  | datashare.CreateSynchronizationSettingsResponse;

const getSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  shareName: string,
  synchronizationSettingName: string,
) =>
  orUndefinedIfNotFound(
    datashare.GetSynchronizationSettings({
      subscriptionId,
      resourceGroupName,
      accountName,
      shareName,
      synchronizationSettingName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  accountName: string,
  shareName: string,
  name: string,
  setting: ObservedSetting,
): SynchronizationSetting["Attributes"] => {
  const props = kindProperties(setting);
  return {
    synchronizationSettingName: name,
    shareName,
    accountName,
    resourceGroup,
    synchronizationSettingId: setting.id ?? "",
    recurrenceInterval: stringProp(props, "recurrenceInterval") ?? "",
    synchronizationTime: stringProp(props, "synchronizationTime") ?? "",
    provisioningState: stringProp(props, "provisioningState") ?? "Succeeded",
  };
};

export const SynchronizationSettingProvider = () =>
  Provider.succeed(SynchronizationSetting, {
    stables: [
      "synchronizationSettingName",
      "shareName",
      "accountName",
      "resourceGroup",
      "synchronizationSettingId",
    ],

    // Settings vanish with their share; the account carries the ownership tags.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Every prop is immutable (the RP rejects a re-PUT with different
      // settings); an unresolved one comes from an upstream resource being
      // created or replaced.
      // An unresolved props object comes from an upstream replacement; every
      // prop is immutable, so that is a replace.
      if (!isResolved(news))
        return { action: "replace", deleteFirst: true } as const;
      const next = news;
      const ci = { caseInsensitive: true };
      if (
        immutableChanged(next.resourceGroup, output.resourceGroup, ci) ||
        immutableChanged(next.account, output.accountName, ci) ||
        immutableChanged(next.share, output.shareName, ci) ||
        (next.name !== undefined &&
          immutableChanged(next.name, output.synchronizationSettingName, ci)) ||
        immutableChanged(next.recurrenceInterval, output.recurrenceInterval) ||
        (olds !== undefined &&
          (!isResolved(next.synchronizationTime) ||
            Date.parse(next.synchronizationTime as string) !==
              Date.parse(olds.synchronizationTime)))
      ) {
        // A share holds one synchronization setting per kind.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.accountName ?? olds?.account;
      const share = output?.shareName ?? olds?.share;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        share === undefined
      ) {
        return undefined;
      }
      const name =
        output?.synchronizationSettingName ??
        olds?.name ??
        (yield* createChildName(id));
      const observed = yield* getSetting(
        subscriptionId,
        resourceGroup,
        account,
        share,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, share, name, observed);
      return (yield* accountOwnedByStack(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataShare");
      const { resourceGroup, account, share } = news;
      const name =
        news.name ??
        output?.synchronizationSettingName ??
        (yield* createChildName(id));
      const get = getSetting(
        subscriptionId,
        resourceGroup,
        account,
        share,
        name,
      );

      // Observe. Settings are immutable: every prop change replaces.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* datashare.CreateSynchronizationSettings({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: account,
          shareName: share,
          synchronizationSettingName: name,
          kind: "ScheduleBased",
          properties: {
            recurrenceInterval: news.recurrenceInterval,
            synchronizationTime: news.synchronizationTime,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `data share synchronization setting ${name}`,
        get,
        (setting) => stringProp(kindProperties(setting), "provisioningState"),
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, account, share, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datashare.DeleteSynchronizationSettings({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
          shareName: output.shareName,
          synchronizationSettingName: output.synchronizationSettingName,
        }),
      );
      yield* waitUntilGone(
        `data share synchronization setting ${output.synchronizationSettingName}`,
        getSetting(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
          output.shareName,
          output.synchronizationSettingName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.DataShare.Account"],
    },
  });
