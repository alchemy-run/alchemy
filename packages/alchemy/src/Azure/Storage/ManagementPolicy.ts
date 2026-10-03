import * as storage from "@distilled.cloud/azure/storage";
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
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

export type LifecycleRuleActions = storage.ManagementPolicyAction;
export type LifecycleRuleFilters = storage.ManagementPolicyFilter;

/** A lifecycle management rule. */
export interface LifecycleRule {
  /** Rule name, unique within the policy (letters and digits, case-sensitive). */
  name: string;
  /**
   * Whether the rule runs.
   * @default true
   */
  enabled?: boolean;
  /**
   * Blobs the rule applies to: `blobTypes` (`blockBlob`, `appendBlob`),
   * optional `prefixMatch` (`container/prefix`) and `blobIndexMatch`.
   * @default all block blobs
   */
  filters?: LifecycleRuleFilters;
  /**
   * Tiering and deletion actions for base blobs, snapshots, and versions.
   */
  actions: LifecycleRuleActions;
}

export interface ManagementPolicyProps {
  /**
   * Resource group of the storage account. Changing it replaces the policy.
   */
  resourceGroup: string;
  /** Storage account the policy applies to. Changing it replaces the policy. */
  storageAccount: string;
  /** Lifecycle rules (at most 100). */
  rules: LifecycleRule[];
}

export interface ManagementPolicy extends Resource<
  "Azure.Storage.ManagementPolicy",
  ManagementPolicyProps,
  {
    /** Storage account the policy applies to. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the policy (`.../managementPolicies/default`). */
    managementPolicyId: string;
    /** Names of the rules in the policy. */
    ruleNames: string[];
    /** When the policy was last modified. */
    lastModifiedTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The lifecycle management policy of a Storage account: rules that move
 * blobs to cooler tiers or delete them as they age.
 *
 * Each account has at most one policy (always named `default`); the policy
 * replaces its whole rule set on every change. Destroying the resource
 * deletes the policy.
 *
 * @see https://learn.microsoft.com/azure/storage/blobs/lifecycle-management-overview
 *
 * ### Lifecycle Rules
 * **Example:** Delete logs after 30 days
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("logs", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Storage.ManagementPolicy("logs-lifecycle", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   rules: [
 *     {
 *       name: "expireLogs",
 *       filters: { blobTypes: ["blockBlob"], prefixMatch: ["logs/"] },
 *       actions: {
 *         baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Tier to cool, then archive
 * ```typescript
 * yield* Azure.Storage.ManagementPolicy("archive-lifecycle", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   rules: [
 *     {
 *       name: "ageOut",
 *       actions: {
 *         baseBlob: {
 *           tierToCool: { daysAfterModificationGreaterThan: 30 },
 *           tierToArchive: { daysAfterModificationGreaterThan: 180 },
 *         },
 *         snapshot: { delete: { daysAfterCreationGreaterThan: 90 } },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ManagementPolicy = Resource<ManagementPolicy>(
  "Azure.Storage.ManagementPolicy",
);

const POLICY_NAME = "default";

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetManagementPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      managementPolicyName: POLICY_NAME,
    }),
  );

const toRules = (
  rules: ReadonlyArray<LifecycleRule>,
): storage.ManagementPolicyRule[] =>
  rules.map((rule) => ({
    name: rule.name,
    enabled: rule.enabled ?? true,
    type: "Lifecycle",
    definition: {
      actions: rule.actions,
      filters: rule.filters ?? { blobTypes: ["blockBlob"] },
    },
  }));

/** Sorted-key JSON with `undefined` members dropped, for comparison. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  policy: storage.GetManagementPolicyResponse,
): ManagementPolicy["Attributes"] => ({
  storageAccount,
  resourceGroup,
  managementPolicyId: policy.id ?? "",
  ruleNames: (policy.properties?.policy.rules ?? []).map((rule) => rule.name),
  lastModifiedTime: policy.properties?.lastModifiedTime,
});

export const ManagementPolicyProvider = () =>
  Provider.succeed(ManagementPolicy, {
    stables: ["storageAccount", "resourceGroup", "managementPolicyId"],

    // A per-account singleton that disappears with its account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        storageAccount,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        storageAccount,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const rules = toRules(news.rules);
      const get = getPolicy(subscriptionId, resourceGroup, storageAccount);

      // Observe; the PUT is a full upsert, so only send it on a delta.
      const observed = yield* get;
      if (
        observed === undefined ||
        canonical(observed.properties?.policy.rules ?? []) !== canonical(rules)
      ) {
        yield* storage.ManagementPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: storageAccount,
          managementPolicyName: POLICY_NAME,
          properties: { policy: { rules } },
        });
      }

      const fresh = yield* waitForProvisioned(
        `management policy of ${storageAccount}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, storageAccount, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteManagementPolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          managementPolicyName: POLICY_NAME,
        }),
      );
      yield* waitUntilGone(
        `management policy of ${output.storageAccount}`,
        getPolicy(subscriptionId, output.resourceGroup, output.storageAccount),
      );
    }),
  });
