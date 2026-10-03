import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  ProvisioningTimedOut,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createSiteRecoveryName,
  matchesDesired,
  ownedOrUnowned,
  retryWhileVaultRegistering,
  sameName,
  SITE_RECOVERY_NAMESPACE,
} from "./Shared.ts";

/**
 * Provider-specific policy settings. The documented fields are the
 * Azure-to-Azure (`A2A`) ones; other providers' fields are passed through.
 */
export interface ReplicationPolicyProviderInput {
  /**
   * Replication provider: `A2A` (Azure-to-Azure), `HyperVReplicaAzure`,
   * `InMageRcm`, `VMwareCbt`, ... Changing it replaces the policy.
   */
  instanceType: string;
  /** How long recovery points are kept, in minutes (A2A, max 15 days). */
  recoveryPointHistory?: number;
  /** App-consistent snapshot frequency in minutes (A2A, 0 disables). */
  appConsistentFrequencyInMinutes?: number;
  /** Crash-consistent snapshot frequency in minutes (A2A, 5). */
  crashConsistentFrequencyInMinutes?: number;
  /** Multi-VM consistency: `Enable` or `Disable` (A2A). */
  multiVmSyncStatus?: "Enable" | "Disable";
  /** Any other provider field. */
  [key: string]: unknown;
}

export interface ReplicationPolicyProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the policy. */
  vault: string;
  /**
   * Policy name, unique within the vault. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * policy.
   */
  name?: string;
  /**
   * Provider-specific settings. Retention and snapshot frequencies are
   * updated in place; changing `instanceType` replaces the policy.
   */
  providerSpecificInput: ReplicationPolicyProviderInput;
}

export interface ReplicationPolicy extends Resource<
  "Azure.SiteRecovery.ReplicationPolicy",
  ReplicationPolicyProps,
  {
    /** Name of the policy. */
    policyName: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the policy; pass it as a container mapping's `policyId`. */
    policyId: string;
    /** Replication provider of the policy, e.g. `A2A`. */
    instanceType: string;
    /** Provider-specific settings as observed in Azure. */
    providerSpecificDetails: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery replication policy: how long recovery points are
 * kept and how often app- and crash-consistent snapshots are taken.
 *
 * Policies cannot be tagged; Alchemy treats a policy as owned when its
 * vault is tagged for the current stack and stage. Retention and snapshot
 * frequencies are updated in place; a policy cannot be deleted while a
 * container mapping uses it, so mappings are removed first.
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-policies/create
 *
 * ### Azure-to-Azure Disaster Recovery
 * **Example:** 24-hour retention with 4-hourly app-consistent snapshots
 * ```typescript
 * const policy = yield* Azure.SiteRecovery.ReplicationPolicy("a2a-policy", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   providerSpecificInput: {
 *     instanceType: "A2A",
 *     recoveryPointHistory: 1440,
 *     appConsistentFrequencyInMinutes: 240,
 *     multiVmSyncStatus: "Enable",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ReplicationPolicy = Resource<ReplicationPolicy>(
  "Azure.SiteRecovery.ReplicationPolicy",
);

type Observed = asr.GetReplicationPolicyResponse;

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  policyName: string,
) =>
  orUndefinedIfNotFound(
    retryWhileVaultRegistering(
      asr.GetReplicationPolicy({
        subscriptionId,
        resourceGroupName,
        resourceName,
        policyName,
      }),
    ),
  );

const detailsOf = (observed: Observed) =>
  (observed.properties?.providerSpecificDetails ?? {}) as Record<
    string,
    unknown
  >;

/**
 * The observed shape of the desired input: the service reports
 * `multiVmSyncStatus` as `Enabled`/`Disabled` while the input takes
 * `Enable`/`Disable`.
 */
const expectedDetails = (input: ReplicationPolicyProviderInput) => {
  const { multiVmSyncStatus, ...rest } = input;
  return multiVmSyncStatus === undefined
    ? rest
    : { ...rest, multiVmSyncStatus: `${multiVmSyncStatus}d` };
};

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  observed: Observed,
): ReplicationPolicy["Attributes"] => {
  const details = detailsOf(observed);
  return {
    policyName: name,
    vault,
    resourceGroup,
    policyId: observed.id ?? "",
    instanceType: String(details.instanceType ?? ""),
    providerSpecificDetails: details,
  };
};

export const ReplicationPolicyProvider = () =>
  Provider.succeed(ReplicationPolicy, {
    stables: ["policyName", "vault", "resourceGroup", "policyId"],

    // Policies live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        (news.name !== undefined && !sameName(news.name, output.policyName)) ||
        !sameName(news.providerSpecificInput.instanceType, output.instanceType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      if (resourceGroup === undefined || vault === undefined) return undefined;
      const name =
        output?.policyName ?? olds?.name ?? (yield* createSiteRecoveryName(id));
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        vault,
        name,
      );
      if (observed === undefined) return undefined;
      return yield* ownedOrUnowned(
        toAttrs(resourceGroup, vault, name, observed),
        output !== undefined,
        subscriptionId,
        resourceGroup,
        vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SITE_RECOVERY_NAMESPACE);
      const { resourceGroup, vault } = news;
      const name =
        news.name ?? output?.policyName ?? (yield* createSiteRecoveryName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: vault,
        policyName: name,
      };
      const get = getPolicy(subscriptionId, resourceGroup, vault, name);
      const expected = expectedDetails(news.providerSpecificInput);

      // Observe.
      const observed = yield* get;

      // Ensure: create when missing.
      if (observed === undefined) {
        yield* retryWhileVaultRegistering(
          asr.CreateReplicationPolicy({
            ...where,
            properties: { providerSpecificInput: news.providerSpecificInput },
          }),
        );
      } else if (!matchesDesired(detailsOf(observed), expected)) {
        // Sync: retention / snapshot settings differ from the observed policy.
        yield* retryWhileVaultRegistering(
          asr.UpdateReplicationPolicy({
            ...where,
            properties: {
              replicationProviderSettings: news.providerSpecificInput,
            },
          }),
        );
      }

      // Both run as ASR jobs: wait until the observed policy converges.
      const fresh = yield* get.pipe(
        Effect.flatMap((policy) =>
          policy !== undefined && matchesDesired(detailsOf(policy), expected)
            ? Effect.succeed(policy)
            : Effect.fail("pending" as const),
        ),
        Effect.retry({
          while: (e) => e === "pending",
          schedule: Schedule.spaced("5 seconds"),
          times: 48,
        }),
        Effect.catchIf(
          (e): e is "pending" => e === "pending",
          () =>
            Effect.fail(
              new ProvisioningTimedOut({
                resource: `site recovery policy ${name}`,
                state: undefined,
                message: `site recovery policy ${name} did not converge after 4 minutes`,
              }),
            ),
        ),
      );
      return toAttrs(resourceGroup, vault, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        retryWhileVaultRegistering(
          asr.DeleteReplicationPolicy({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.vault,
            policyName: output.policyName,
          }),
        ),
      );
      yield* waitUntilGone(
        `site recovery policy ${output.policyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.vault,
          output.policyName,
        ),
        { interval: "5 seconds", times: 48 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.SiteRecovery.ProtectionContainerMapping",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
