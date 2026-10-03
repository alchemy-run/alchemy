import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import * as Effect from "effect/Effect";
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
  createDataReplicationName,
  DATA_REPLICATION_NAMESPACE,
  type DataReplicationCustomProperties,
  matchesDesired,
  ownedByVaultOrUnowned,
  sameName,
} from "./Shared.ts";

export interface PolicyProps {
  /** Resource group of the vault. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the data replication vault. Changing it replaces the policy. */
  vault: string;
  /**
   * Name of the policy: letters and digits only. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the policy.
   */
  name?: string;
  /**
   * Replication settings, discriminated by `instanceType`
   * (`HyperVToAzStackHCI` or `VMwareToAzStackHCI`), e.g.
   * `{ instanceType: "VMwareToAzStackHCI", recoveryPointHistoryInMinutes: 4320,
   * crashConsistentFrequencyInMinutes: 60, appConsistentFrequencyInMinutes: 240 }`.
   * Changing `instanceType` replaces the policy; other fields are updated
   * in place.
   */
  customProperties: DataReplicationCustomProperties;
}

export interface Policy extends Resource<
  "Azure.DataReplication.Policy",
  PolicyProps,
  {
    /** Name of the policy. */
    policyName: string;
    /** Name of the vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Provisioning state of the policy. */
    provisioningState: string | undefined;
    /** Observed replication settings. */
    customProperties: Record<string, unknown> | undefined;
  },
  never,
  Providers
> {}

/**
 * A replication policy in an Azure Site Recovery data replication vault:
 * how often crash- and app-consistent recovery points are taken and how
 * long they are kept for Hyper-V or VMware machines replicating to Azure
 * Local (Azure Stack HCI).
 *
 * Policies cannot be tagged; Alchemy treats one as owned when its vault is
 * tagged for the current stack and stage.
 *
 * @see https://learn.microsoft.com/rest/api/datareplication/policy/create
 *
 * ### Creating a Policy
 * **Example:** VMware to Azure Local policy
 * ```typescript
 * const vault = yield* Azure.DataReplication.Vault("vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const policy = yield* Azure.DataReplication.Policy("policy", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   customProperties: {
 *     instanceType: "VMwareToAzStackHCI",
 *     recoveryPointHistoryInMinutes: 4320,
 *     crashConsistentFrequencyInMinutes: 60,
 *     appConsistentFrequencyInMinutes: 240,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Policy = Resource<Policy>("Azure.DataReplication.Policy");

type Observed = dr.GetPolicyResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  vaultName: string;
  policyName: string;
}

const getPolicy = (where: Where) =>
  orUndefinedIfNotFound(dr.GetPolicy(where));

const customOf = (observed: Observed) =>
  (observed.properties?.customProperties ?? undefined) as
    | Record<string, unknown>
    | undefined;

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  observed: Observed,
): Policy["Attributes"] => ({
  policyName: name,
  vault,
  resourceGroup,
  policyId: observed.id ?? "",
  provisioningState: observed.properties?.provisioningState,
  customProperties: customOf(observed),
});

export const PolicyProvider = () =>
  Provider.succeed(Policy, {
    stables: ["policyName", "vault", "resourceGroup", "policyId"],

    // A vault child that disappears with its vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        (news.name !== undefined && !sameName(news.name, output.policyName)) ||
        (output.customProperties?.instanceType !== undefined &&
          !sameName(
            news.customProperties.instanceType,
            String(output.customProperties.instanceType),
          ))
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
        output?.policyName ??
        olds?.name ??
        (yield* createDataReplicationName(id));
      const observed = yield* getPolicy({
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: vault,
        policyName: name,
      });
      if (observed === undefined) return undefined;
      return yield* ownedByVaultOrUnowned(
        toAttrs(resourceGroup, vault, name, observed),
        output !== undefined,
        subscriptionId,
        resourceGroup,
        vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DATA_REPLICATION_NAMESPACE);
      const name =
        news.name ??
        output?.policyName ??
        (yield* createDataReplicationName(id));
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        vaultName: news.vault,
        policyName: name,
      };
      const get = getPolicy(where);

      // Observe; PUT (an upsert LRO) only when missing or drifted.
      const observed = yield* get;
      if (
        observed === undefined ||
        !matchesDesired(customOf(observed), news.customProperties)
      ) {
        yield* dr.CreatePolicy({
          ...where,
          properties: { customProperties: news.customProperties },
        });
      }
      const fresh = yield* waitForProvisioned(
        `data replication policy ${name}`,
        get,
        (policy) =>
          matchesDesired(customOf(policy), news.customProperties)
            ? policy.properties?.provisioningState
            : "Updating",
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(news.resourceGroup, news.vault, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        vaultName: output.vault,
        policyName: output.policyName,
      };
      yield* ignoreNotFound(dr.DeletePolicy(where));
      yield* waitUntilGone(
        `data replication policy ${output.policyName}`,
        getPolicy(where),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
