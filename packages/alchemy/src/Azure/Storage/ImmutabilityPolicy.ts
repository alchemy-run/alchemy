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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

export interface ImmutabilityPolicyProps {
  /** Resource group of the storage account. Changing it replaces the policy. */
  resourceGroup: string;
  /** Storage account that holds the container. Changing it replaces the policy. */
  storageAccount: string;
  /** Blob container the policy protects. Changing it replaces the policy. */
  container: string;
  /**
   * Retention period, in days since blob creation (1-146000). Blobs cannot
   * be modified or deleted until they are older than this.
   */
  immutabilityPeriodSinceCreationInDays: number;
  /**
   * Allow new blocks to be appended to append blobs while they are
   * protected. Mutually exclusive with `allowProtectedAppendWritesAll`.
   * @default false
   */
  allowProtectedAppendWrites?: boolean;
  /**
   * Allow new blocks to be written to both append and block blobs while
   * they are protected. Mutually exclusive with `allowProtectedAppendWrites`.
   * @default false
   */
  allowProtectedAppendWritesAll?: boolean;
}

export interface ImmutabilityPolicy extends Resource<
  "Azure.Storage.ImmutabilityPolicy",
  ImmutabilityPolicyProps,
  {
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** Storage account that holds the container. */
    storageAccount: string;
    /** Blob container the policy protects. */
    container: string;
    /** ARM resource ID of the policy. */
    immutabilityPolicyId: string;
    /** Retention period in days since blob creation. */
    immutabilityPeriodSinceCreationInDays: number;
    /** Whether append-blob appends are allowed while protected. */
    allowProtectedAppendWrites: boolean;
    /** Whether block and append blob writes are allowed while protected. */
    allowProtectedAppendWritesAll: boolean;
    /** Policy state: `Unlocked` (Alchemy never locks a policy). */
    state: string;
    /** ETag of the policy. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A time-based retention (WORM) policy on a blob container: blobs cannot
 * be modified or deleted until they are older than the retention period.
 *
 * Alchemy manages the policy in the **Unlocked** state, where the period
 * can still be changed and the policy removed. Locking a policy is
 * irreversible (it makes the container and account undeletable until every
 * blob expires), so Alchemy never locks one; destroying the resource aborts
 * the unlocked policy.
 *
 * @see https://learn.microsoft.com/azure/storage/blobs/immutable-time-based-retention-policy-overview
 *
 * ### Protecting a Container
 * **Example:** Seven-day retention
 * ```typescript
 * const archive = yield* Azure.Storage.BlobContainer("archive", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * yield* Azure.Storage.ImmutabilityPolicy("archive-retention", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   container: archive.containerName,
 *   immutabilityPeriodSinceCreationInDays: 7,
 * });
 * ```
 *
 * **Example:** Retention that still allows appends
 * ```typescript
 * yield* Azure.Storage.ImmutabilityPolicy("logs-retention", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   container: logs.containerName,
 *   immutabilityPeriodSinceCreationInDays: 30,
 *   allowProtectedAppendWrites: true,
 * });
 * ```
 *
 * @resource
 */
export const ImmutabilityPolicy = Resource<ImmutabilityPolicy>(
  "Azure.Storage.ImmutabilityPolicy",
);

/**
 * Observe the container's policy. A container without a policy reports an
 * empty `Deleted` policy (period 0) rather than a not-found error.
 */
const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  containerName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetBlobContainerImmutabilityPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      containerName,
    }),
  ).pipe(
    Effect.map((policy) =>
      policy === undefined ||
      policy.properties.state === "Deleted" ||
      (policy.properties.immutabilityPeriodSinceCreationInDays ?? 0) === 0
        ? undefined
        : policy,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  container: string,
  policy: storage.GetBlobContainerImmutabilityPolicyResponse,
): ImmutabilityPolicy["Attributes"] => ({
  resourceGroup,
  storageAccount,
  container,
  immutabilityPolicyId: policy.id ?? "",
  immutabilityPeriodSinceCreationInDays:
    policy.properties.immutabilityPeriodSinceCreationInDays ?? 0,
  allowProtectedAppendWrites:
    policy.properties.allowProtectedAppendWrites ?? false,
  allowProtectedAppendWritesAll:
    policy.properties.allowProtectedAppendWritesAll ?? false,
  state: policy.properties.state ?? "Unlocked",
  etag: policy.etag,
});

export const ImmutabilityPolicyProvider = () =>
  Provider.succeed(ImmutabilityPolicy, {
    stables: [
      "resourceGroup",
      "storageAccount",
      "container",
      "immutabilityPolicyId",
    ],

    // Policies disappear with their container.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        news.container !== output.container
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      const container = output?.container ?? olds?.container;
      if (
        resourceGroup === undefined ||
        storageAccount === undefined ||
        container === undefined
      ) {
        return undefined;
      }
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        storageAccount,
        container,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, container, observed);
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
      const { resourceGroup, storageAccount, container } = news;
      const desired = {
        immutabilityPeriodSinceCreationInDays:
          news.immutabilityPeriodSinceCreationInDays,
        allowProtectedAppendWrites: news.allowProtectedAppendWrites ?? false,
        allowProtectedAppendWritesAll:
          news.allowProtectedAppendWritesAll ?? false,
      };
      const get = getPolicy(
        subscriptionId,
        resourceGroup,
        storageAccount,
        container,
      );

      // Observe, then upsert only on a delta.
      const observed = yield* get;
      if (
        observed === undefined ||
        observed.properties.immutabilityPeriodSinceCreationInDays !==
          desired.immutabilityPeriodSinceCreationInDays ||
        (observed.properties.allowProtectedAppendWrites ?? false) !==
          desired.allowProtectedAppendWrites ||
        (observed.properties.allowProtectedAppendWritesAll ?? false) !==
          desired.allowProtectedAppendWritesAll
      ) {
        const written =
          yield* storage.BlobContainersCreateOrUpdateImmutabilityPolicy({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: storageAccount,
            containerName: container,
            properties: desired,
          });
        return toAttrs(resourceGroup, storageAccount, container, written);
      }
      return toAttrs(resourceGroup, storageAccount, container, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const get = getPolicy(
        subscriptionId,
        output.resourceGroup,
        output.storageAccount,
        output.container,
      );
      // Aborting requires the current ETag.
      const observed = yield* get;
      if (observed?.etag !== undefined) {
        yield* ignoreNotFound(
          storage.DeleteBlobContainerImmutabilityPolicy({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.storageAccount,
            containerName: output.container,
            ifMatch: observed.etag,
          }),
        );
      }
      yield* waitUntilGone(`immutability policy of ${output.container}`, get, {
        interval: "2 seconds",
        times: 15,
      });
    }),

    nuke: {
      dependsOn: [
        "Azure.Storage.BlobContainer",
        "Azure.Storage.StorageAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
