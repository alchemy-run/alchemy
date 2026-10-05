import * as storage from "@distilled.cloud/azure/storage";
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
  requireSinglePage,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

/** A container pair replicated by the policy. */
export interface ObjectReplicationRule {
  /** Container in the source account. */
  sourceContainer: string;
  /** Container in the destination account. */
  destinationContainer: string;
  /** Only replicate blobs whose names start with one of these prefixes. */
  prefixMatch?: string[];
  /**
   * Only replicate blobs created after this time
   * (`yyyy-MM-ddTHH:mm:ssZ`).
   * @default only blobs written after the policy is created
   */
  minCreationTime?: string;
}

export interface ObjectReplicationPolicyProps {
  /**
   * Resource group of the destination account. Changing it replaces the
   * policy.
   */
  resourceGroup: string;
  /**
   * Storage account blobs are replicated to. Changing it replaces the
   * policy.
   */
  destinationAccount: string;
  /**
   * Storage account blobs are replicated from. Changing it replaces the
   * policy.
   */
  sourceAccount: string;
  /**
   * Resource group of the source account. Changing it replaces the policy.
   * @default `resourceGroup`
   */
  sourceResourceGroup?: string;
  /** Container pairs to replicate (at most 1000). */
  rules: ObjectReplicationRule[];
  /**
   * Whether replication metrics are emitted.
   * @default unmanaged
   */
  metricsEnabled?: boolean;
  /**
   * Whether tag-based blob changes are replicated.
   * @default unmanaged
   */
  tagsReplicationEnabled?: boolean;
}

/** A replicated container pair with the rule ID Azure assigned. */
export interface ObjectReplicationRuleAttributes {
  /** Rule ID assigned by Azure. */
  ruleId: string;
  /** Container in the source account. */
  sourceContainer: string;
  /** Container in the destination account. */
  destinationContainer: string;
}

export interface ObjectReplicationPolicy extends Resource<
  "Azure.Storage.ObjectReplicationPolicy",
  ObjectReplicationPolicyProps,
  {
    /** Policy ID assigned by Azure (shared by both accounts). */
    policyId: string;
    /** ARM resource ID of the policy on the destination account. */
    objectReplicationPolicyId: string;
    /** Resource group of the destination account. */
    resourceGroup: string;
    /** Storage account blobs are replicated to. */
    destinationAccount: string;
    /** Storage account blobs are replicated from. */
    sourceAccount: string;
    /** Resource group of the source account. */
    sourceResourceGroup: string;
    /** Rules with the IDs Azure assigned. */
    rules: ObjectReplicationRuleAttributes[];
    /** When the policy was enabled on the source account. */
    enabledTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Object replication between two Storage accounts: block blobs written to
 * source containers are copied asynchronously to destination containers.
 *
 * Both accounts need blob versioning, and the source account needs the
 * change feed (see `BlobServiceProperties`). The policy is created on the
 * destination account first (Azure assigns the policy and rule IDs) and
 * then mirrored onto the source account; destroying the resource removes
 * it from both.
 *
 * @see https://learn.microsoft.com/azure/storage/blobs/object-replication-overview
 *
 * ### Replicating Containers
 * **Example:** Replicate one container to another account
 * ```typescript
 * const source = yield* Azure.Storage.StorageAccount("primary", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const destination = yield* Azure.Storage.StorageAccount("replica", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const sourceBlob = yield* Azure.Storage.BlobServiceProperties("primary-blob", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: source.storageAccountName,
 *   isVersioningEnabled: true,
 *   changeFeed: { enabled: true },
 * });
 * const destinationBlob = yield* Azure.Storage.BlobServiceProperties(
 *   "replica-blob",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     storageAccount: destination.storageAccountName,
 *     isVersioningEnabled: true,
 *   },
 * );
 * const images = yield* Azure.Storage.BlobContainer("images", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: source.storageAccountName,
 * });
 * const imagesCopy = yield* Azure.Storage.BlobContainer("images-copy", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: destination.storageAccountName,
 * });
 * yield* Azure.Storage.ObjectReplicationPolicy("images-replication", {
 *   resourceGroup: group.resourceGroupName,
 *   // Referencing the settings resources orders the policy after them.
 *   sourceAccount: sourceBlob.storageAccount,
 *   destinationAccount: destinationBlob.storageAccount,
 *   rules: [
 *     {
 *       sourceContainer: images.containerName,
 *       destinationContainer: imagesCopy.containerName,
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Replicate only a prefix, including existing blobs
 * ```typescript
 * yield* Azure.Storage.ObjectReplicationPolicy("images-replication", {
 *   resourceGroup: group.resourceGroupName,
 *   sourceAccount: sourceBlob.storageAccount,
 *   destinationAccount: destinationBlob.storageAccount,
 *   rules: [
 *     {
 *       sourceContainer: images.containerName,
 *       destinationContainer: imagesCopy.containerName,
 *       prefixMatch: ["published/"],
 *       minCreationTime: "2024-01-01T00:00:00Z",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ObjectReplicationPolicy = Resource<ObjectReplicationPolicy>(
  "Azure.Storage.ObjectReplicationPolicy",
);

export class ObjectReplicationPolicyMissing extends Data.TaggedError(
  "Azure.Storage.ObjectReplicationPolicyMissing",
)<{ readonly message: string }> {}

type Observed = storage.GetObjectReplicationPolicyResponse;

const accountId = (
  subscriptionId: string,
  resourceGroup: string,
  account: string,
) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${account}`;

/** Azure stores either the account name or its full resource ID. */
const sameAccount = (observed: string | undefined, account: string) => {
  const value = (observed ?? "").toLowerCase();
  const name = account.toLowerCase();
  return value === name || value.endsWith(`/storageaccounts/${name}`);
};

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  objectReplicationPolicyId: string,
) =>
  orUndefinedIfNotFound(
    storage.GetObjectReplicationPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      objectReplicationPolicyId,
    }),
  );

/** The policy on `accountName` that replicates from `sourceAccount`. */
const findPolicy = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  sourceAccount: string,
) {
  const page = yield* orUndefinedIfNotFound(
    storage
      .ListObjectReplicationPolicies({
        subscriptionId,
        resourceGroupName,
        accountName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListObjectReplicationPolicies", page),
        ),
      ),
  );
  return (page?.value ?? []).find((policy) =>
    sameAccount(policy.properties?.sourceAccount, sourceAccount),
  );
});

/** Comparable rule content (rule IDs excluded). */
const ruleKey = (
  rules: ReadonlyArray<{
    sourceContainer: string;
    destinationContainer: string;
    filters?: { prefixMatch?: ReadonlyArray<string>; minCreationTime?: string };
  }>,
) =>
  JSON.stringify(
    rules
      .map((rule) => ({
        source: rule.sourceContainer,
        destination: rule.destinationContainer,
        prefixMatch: [...(rule.filters?.prefixMatch ?? [])].sort(),
        minCreationTime:
          rule.filters?.minCreationTime === undefined
            ? undefined
            : new Date(rule.filters.minCreationTime).getTime(),
      }))
      .sort((a, b) =>
        `${a.source}/${a.destination}`.localeCompare(
          `${b.source}/${b.destination}`,
        ),
      ),
  );

const flagDiffers = (
  observed: { enabled?: boolean } | undefined,
  desired: boolean | undefined,
) => desired !== undefined && (observed?.enabled ?? false) !== desired;

/** Desired rules, carrying the rule IDs of matching observed rules. */
const desiredRules = (
  news: ObjectReplicationPolicyProps,
  observed: Observed | undefined,
): storage.ObjectReplicationPolicyRule[] =>
  news.rules.map((rule) => {
    const match = (observed?.properties?.rules ?? []).find(
      (existing) =>
        existing.sourceContainer === rule.sourceContainer &&
        existing.destinationContainer === rule.destinationContainer,
    );
    return {
      ruleId: match?.ruleId,
      sourceContainer: rule.sourceContainer,
      destinationContainer: rule.destinationContainer,
      filters:
        rule.prefixMatch === undefined && rule.minCreationTime === undefined
          ? undefined
          : {
              prefixMatch: rule.prefixMatch,
              minCreationTime: rule.minCreationTime,
            },
    };
  });

/** Whether an observed policy differs from the desired rules and flags. */
const policyDiffers = (
  observed: Observed | undefined,
  rules: ReadonlyArray<storage.ObjectReplicationPolicyRule>,
  news: ObjectReplicationPolicyProps,
) =>
  observed === undefined ||
  ruleKey(observed.properties?.rules ?? []) !== ruleKey(rules) ||
  flagDiffers(observed.properties?.metrics, news.metricsEnabled) ||
  flagDiffers(
    observed.properties?.tagsReplication,
    news.tagsReplicationEnabled,
  );

const toAttrs = (
  news: {
    resourceGroup: string;
    sourceResourceGroup: string;
    sourceAccount: string;
    destinationAccount: string;
  },
  destination: Observed,
  source: Observed | undefined,
): ObjectReplicationPolicy["Attributes"] => ({
  policyId: destination.properties?.policyId ?? destination.name ?? "",
  objectReplicationPolicyId: destination.id ?? "",
  resourceGroup: news.resourceGroup,
  sourceResourceGroup: news.sourceResourceGroup,
  sourceAccount: news.sourceAccount,
  destinationAccount: news.destinationAccount,
  rules: (destination.properties?.rules ?? []).map((rule) => ({
    ruleId: rule.ruleId ?? "",
    sourceContainer: rule.sourceContainer,
    destinationContainer: rule.destinationContainer,
  })),
  enabledTime:
    source?.properties?.enabledTime ?? destination.properties?.enabledTime,
});

export const ObjectReplicationPolicyProvider = () =>
  Provider.succeed(ObjectReplicationPolicy, {
    stables: [
      "policyId",
      "objectReplicationPolicyId",
      "resourceGroup",
      "sourceResourceGroup",
      "sourceAccount",
      "destinationAccount",
    ],

    // Policies disappear with their storage accounts.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sourceResourceGroup =
        news.sourceResourceGroup ?? news.resourceGroup;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        sourceResourceGroup.toLowerCase() !==
          output.sourceResourceGroup.toLowerCase() ||
        news.sourceAccount !== output.sourceAccount ||
        news.destinationAccount !== output.destinationAccount
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const destinationAccount =
        output?.destinationAccount ?? olds?.destinationAccount;
      const sourceAccount = output?.sourceAccount ?? olds?.sourceAccount;
      if (
        resourceGroup === undefined ||
        destinationAccount === undefined ||
        sourceAccount === undefined
      ) {
        return undefined;
      }
      const sourceResourceGroup =
        output?.sourceResourceGroup ??
        olds?.sourceResourceGroup ??
        resourceGroup;
      const observed =
        output?.policyId !== undefined
          ? yield* getPolicy(
              subscriptionId,
              resourceGroup,
              destinationAccount,
              output.policyId,
            )
          : yield* findPolicy(
              subscriptionId,
              resourceGroup,
              destinationAccount,
              sourceAccount,
            );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        {
          resourceGroup,
          sourceResourceGroup,
          sourceAccount,
          destinationAccount,
        },
        observed,
        undefined,
      );
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        destinationAccount,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, sourceAccount, destinationAccount } = news;
      const sourceResourceGroup = news.sourceResourceGroup ?? resourceGroup;
      const sourceId = accountId(
        subscriptionId,
        sourceResourceGroup,
        sourceAccount,
      );
      const destinationId = accountId(
        subscriptionId,
        resourceGroup,
        destinationAccount,
      );
      const findOnDestination = findPolicy(
        subscriptionId,
        resourceGroup,
        destinationAccount,
        sourceAccount,
      );

      // Observe the destination side: by the cached policy ID, else by the
      // source account (one policy per account pair).
      let destination =
        output?.policyId !== undefined
          ? yield* getPolicy(
              subscriptionId,
              resourceGroup,
              destinationAccount,
              output.policyId,
            )
          : undefined;
      destination ??= yield* findOnDestination;

      const flags = {
        metrics:
          news.metricsEnabled === undefined
            ? undefined
            : { enabled: news.metricsEnabled },
        tagsReplication:
          news.tagsReplicationEnabled === undefined
            ? undefined
            : { enabled: news.tagsReplicationEnabled },
      };

      // Ensure + sync the destination side. A new policy is created with
      // the ID `default`; Azure assigns the real policy and rule IDs.
      const rules = desiredRules(news, destination);
      if (policyDiffers(destination, rules, news)) {
        const written = yield* storage.ObjectReplicationPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: destinationAccount,
          objectReplicationPolicyId:
            destination?.properties?.policyId ?? destination?.name ?? "default",
          properties: {
            sourceAccount: sourceId,
            destinationAccount: destinationId,
            rules,
            ...flags,
          },
        });
        destination =
          written.properties?.policyId !== undefined
            ? written
            : yield* findOnDestination.pipe(
                Effect.flatMap((found) =>
                  found === undefined
                    ? Effect.fail(
                        new ObjectReplicationPolicyMissing({
                          message: `object replication policy from ${sourceAccount} not visible on ${destinationAccount} yet`,
                        }),
                      )
                    : Effect.succeed(found),
                ),
                Effect.retry({
                  while: (e) =>
                    e._tag === "Azure.Storage.ObjectReplicationPolicyMissing",
                  schedule: Schedule.spaced("2 seconds"),
                  times: 15,
                }),
              );
      }
      const policyId = destination?.properties?.policyId ?? destination?.name;
      if (destination === undefined || policyId === undefined) {
        return yield* new ObjectReplicationPolicyMissing({
          message: `Azure returned no policy ID for the replication policy on ${destinationAccount}`,
        });
      }

      // Mirror the destination policy (with its assigned IDs) onto the
      // source account.
      const destinationRules = destination.properties?.rules ?? [];
      let source = yield* getPolicy(
        subscriptionId,
        sourceResourceGroup,
        sourceAccount,
        policyId,
      );
      if (
        policyDiffers(source, destinationRules, news) ||
        JSON.stringify(
          (source?.properties?.rules ?? []).map((r) => r.ruleId).sort(),
        ) !== JSON.stringify(destinationRules.map((r) => r.ruleId).sort())
      ) {
        source = yield* storage.ObjectReplicationPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: sourceResourceGroup,
          accountName: sourceAccount,
          objectReplicationPolicyId: policyId,
          properties: {
            sourceAccount: sourceId,
            destinationAccount: destinationId,
            rules: destinationRules,
            ...flags,
          },
        });
      }

      return toAttrs(
        {
          resourceGroup,
          sourceResourceGroup,
          sourceAccount,
          destinationAccount,
        },
        destination,
        source,
      );
    }),

    // Remove the policy from the source account first, then the
    // destination.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteObjectReplicationPolicy({
          subscriptionId,
          resourceGroupName: output.sourceResourceGroup,
          accountName: output.sourceAccount,
          objectReplicationPolicyId: output.policyId,
        }),
      );
      yield* ignoreNotFound(
        storage.DeleteObjectReplicationPolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.destinationAccount,
          objectReplicationPolicyId: output.policyId,
        }),
      );
      yield* waitUntilGone(
        `object replication policy ${output.policyId}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.destinationAccount,
          output.policyId,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Storage.StorageAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
