import * as netapp from "@distilled.cloud/azure/netapp";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountLocation,
  createNetAppName,
  accountRefs,
  listAllAccounts,
  LRO_BUDGET,
  matchesObserved,
  parseNetAppId,
  whileBusy,
} from "./Common.ts";

/** Hourly snapshot schedule. */
export interface SnapshotPolicyHourlySchedule {
  /** Number of hourly snapshots to keep. */
  snapshotsToKeep: number;
  /** Minute of the hour the snapshot is taken (0-59). */
  minute: number;
}

/** Daily snapshot schedule. */
export interface SnapshotPolicyDailySchedule {
  /** Number of daily snapshots to keep. */
  snapshotsToKeep: number;
  /** Hour of the day (UTC, 0-23). */
  hour: number;
  /** Minute of the hour (0-59). */
  minute: number;
}

/** Weekly snapshot schedule. */
export interface SnapshotPolicyWeeklySchedule {
  /** Number of weekly snapshots to keep. */
  snapshotsToKeep: number;
  /** Comma-separated weekdays, e.g. `Monday,Thursday`. */
  day: string;
  /** Hour of the day (UTC, 0-23). */
  hour: number;
  /** Minute of the hour (0-59). */
  minute: number;
}

/** Monthly snapshot schedule. */
export interface SnapshotPolicyMonthlySchedule {
  /** Number of monthly snapshots to keep. */
  snapshotsToKeep: number;
  /** Comma-separated days of the month, e.g. `1,15`. */
  daysOfMonth: string;
  /** Hour of the day (UTC, 0-23). */
  hour: number;
  /** Minute of the hour (0-59). */
  minute: number;
}

export interface SnapshotPolicyProps {
  /** Resource group of the NetApp account. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the NetApp account. Changing it replaces the policy. */
  account: string;
  /**
   * Policy name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the policy.
   */
  name?: string;
  /** Hourly schedule. */
  hourlySchedule?: SnapshotPolicyHourlySchedule;
  /** Daily schedule. */
  dailySchedule?: SnapshotPolicyDailySchedule;
  /** Weekly schedule. */
  weeklySchedule?: SnapshotPolicyWeeklySchedule;
  /** Monthly schedule. */
  monthlySchedule?: SnapshotPolicyMonthlySchedule;
  /**
   * Whether the policy takes snapshots.
   * @default true
   */
  enabled?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SnapshotPolicy extends Resource<
  "Azure.NetApp.SnapshotPolicy",
  SnapshotPolicyProps,
  {
    /** Name of the snapshot policy. */
    snapshotPolicyName: string;
    /** ARM resource ID of the policy; assign it to volumes via `snapshotPolicyId`. */
    snapshotPolicyId: string;
    /** Parent NetApp account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Location of the policy. */
    location: string;
    /** Whether the policy is enabled. */
    enabled: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure NetApp Files snapshot policy — hourly, daily, weekly, and
 * monthly schedules that take and rotate snapshots of the volumes it is
 * assigned to. Free.
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/snapshots-manage-policy
 *
 * ### Creating a Snapshot Policy
 * **Example:** Daily and weekly snapshots
 * ```typescript
 * const policy = yield* Azure.NetApp.SnapshotPolicy("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   dailySchedule: { snapshotsToKeep: 7, hour: 2, minute: 0 },
 *   weeklySchedule: { snapshotsToKeep: 4, day: "Sunday", hour: 3, minute: 0 },
 * });
 * ```
 *
 * ### Pausing a Policy
 * **Example:** Disable the policy
 * ```typescript
 * const policy = yield* Azure.NetApp.SnapshotPolicy("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   dailySchedule: { snapshotsToKeep: 7, hour: 2, minute: 0 },
 *   enabled: false,
 * });
 * ```
 *
 * @resource
 */
export const SnapshotPolicy = Resource<SnapshotPolicy>(
  "Azure.NetApp.SnapshotPolicy",
);

const getSnapshotPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  snapshotPolicyName: string,
) =>
  orUndefinedIfNotFound(
    netapp.GetSnapshotPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      snapshotPolicyName,
    }),
  );

type ObservedPolicy = netapp.GetSnapshotPolicyResponse | netapp.SnapshotPolicy;

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  policy: ObservedPolicy,
): SnapshotPolicy["Attributes"] => ({
  snapshotPolicyName: name,
  snapshotPolicyId: policy.id ?? "",
  account,
  resourceGroup,
  location: policy.location ?? "",
  enabled: policy.properties?.enabled ?? false,
  tags: userTags(policy.tags),
});

export const SnapshotPolicyProvider = () =>
  Provider.succeed(SnapshotPolicy, {
    stables: [
      "snapshotPolicyName",
      "snapshotPolicyId",
      "account",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const accounts = yield* listAllAccounts(subscriptionId);
      const policies = yield* Effect.forEach(
        accountRefs(accounts),
        ({ resourceGroup, accountName }) =>
          orUndefinedIfNotFound(
            netapp
              .ListSnapshotPolicies({
                subscriptionId,
                resourceGroupName: resourceGroup,
                accountName,
              })
              .pipe(
                Effect.flatMap((page) =>
                  requireSinglePage("ListSnapshotPolicies", page),
                ),
              ),
          ).pipe(Effect.map((page) => page?.value ?? [])),
      );
      return policies.flat().flatMap((policy) => {
        const { resourceGroup, account, name } = parseNetAppId(policy.id);
        return hasAnyAlchemyTag(policy.tags) && resourceGroup && account && name
          ? [toAttrs(resourceGroup, account, name, policy)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.snapshotPolicyName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (!resourceGroup || !account) return undefined;
      const name =
        output?.snapshotPolicyName ??
        olds?.name ??
        (yield* createNetAppName(id, 64));
      const observed = yield* getSnapshotPolicy(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const { resourceGroup, account } = news;
      const name =
        news.name ??
        output?.snapshotPolicyName ??
        (yield* createNetAppName(id, 64));
      const tags = yield* desiredTags(id, news.tags);
      const desired: netapp.SnapshotPolicyPropertiesInput = {
        hourlySchedule: news.hourlySchedule,
        dailySchedule: news.dailySchedule,
        weeklySchedule: news.weeklySchedule,
        monthlySchedule: news.monthlySchedule,
        enabled: news.enabled ?? true,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        snapshotPolicyName: name,
      };
      const get = getSnapshotPolicy(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      const waitReady = waitForProvisioned(
        `snapshot policy ${name}`,
        get,
        (policy) => policy.properties?.provisioningState,
        LRO_BUDGET,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          output?.location ??
          (yield* accountLocation(subscriptionId, resourceGroup, account));
        yield* whileBusy(
          netapp.CreateSnapshotPolicy({
            ...where,
            location,
            tags,
            properties: desired,
          }),
        );
      }
      observed = yield* waitReady;

      // Sync schedules, enabled flag, and tags against observed state.
      const propsChanged = !matchesObserved(desired, observed.properties);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || tagsChanged) {
        yield* whileBusy(
          netapp.UpdateSnapshotPolicy({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: propsChanged ? desired : undefined,
          }),
        );
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, account, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* whileBusy(
        ignoreNotFound(
          netapp.DeleteSnapshotPolicy({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            snapshotPolicyName: output.snapshotPolicyName,
          }),
        ),
      );
      yield* waitUntilGone(
        `snapshot policy ${output.snapshotPolicyName}`,
        getSnapshotPolicy(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.snapshotPolicyName,
        ),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.NetApp.Account", "Azure.Resources.ResourceGroup"],
    },
  });
