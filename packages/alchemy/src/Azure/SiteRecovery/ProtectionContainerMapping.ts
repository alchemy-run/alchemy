import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
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
  createSiteRecoveryName,
  matchesDesired,
  ownedOrUnowned,
  sameName,
  SITE_RECOVERY_NAMESPACE,
} from "./Shared.ts";

/**
 * Provider-specific pairing settings. The documented fields are the
 * Azure-to-Azure (`A2A`) ones; other providers' fields are passed through.
 */
export interface ProtectionContainerMappingProviderInput {
  /** Replication provider, e.g. `A2A`. Changing it replaces the mapping. */
  instanceType: string;
  /**
   * Whether ASR keeps the Mobility agent on protected VMs up to date (A2A).
   * Enabling it without `automationAccountArmId` lets ASR create an
   * automation account in the vault's resource group.
   */
  agentAutoUpdateStatus?: "Enabled" | "Disabled";
  /** Automation account that runs the agent update runbook (A2A). */
  automationAccountArmId?: string;
  /** How the automation account authenticates (A2A). */
  automationAccountAuthenticationType?:
    | "RunAsAccount"
    | "SystemAssignedIdentity";
  /** Any other provider field. */
  [key: string]: unknown;
}

export interface ProtectionContainerMappingProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the mapping. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the mapping. */
  vault: string;
  /** Name of the primary fabric. Changing it replaces the mapping. */
  fabric: string;
  /** Name of the primary protection container. Changing it replaces the mapping. */
  protectionContainer: string;
  /**
   * Mapping name, unique within the container. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * mapping.
   */
  name?: string;
  /** ARM ID of the recovery protection container. Changing it replaces the mapping. */
  targetProtectionContainerId: string;
  /** ARM ID of the replication policy. Changing it replaces the mapping. */
  policyId: string;
  /**
   * Provider-specific settings. Agent auto-update settings are updated in
   * place; changing `instanceType` replaces the mapping.
   * @default { instanceType: "A2A" }
   */
  providerSpecificInput?: ProtectionContainerMappingProviderInput;
}

export interface ProtectionContainerMapping extends Resource<
  "Azure.SiteRecovery.ProtectionContainerMapping",
  ProtectionContainerMappingProps,
  {
    /** Name of the mapping. */
    mappingName: string;
    /** Name of the primary protection container. */
    protectionContainer: string;
    /** Name of the primary fabric. */
    fabric: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the mapping. */
    mappingId: string;
    /** ARM ID of the recovery protection container. */
    targetProtectionContainerId: string;
    /** ARM ID of the replication policy. */
    policyId: string;
    /** Pairing state, e.g. `Paired`. */
    state: string | undefined;
    /** Mapping health, e.g. `Normal`. */
    health: string | undefined;
    /** Provider-specific settings as observed in Azure. */
    providerSpecificDetails: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery protection container mapping: pairs a primary
 * protection container with a recovery container under a replication
 * policy. VMs in the primary container replicate to the recovery region
 * with the policy's settings.
 *
 * Mappings cannot be tagged; Alchemy treats a mapping as owned when its
 * vault is tagged for the current stack and stage. Agent auto-update
 * settings are updated in place; the containers and policy are immutable.
 * Delete is the graceful `remove` (unpair) operation.
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-protection-container-mappings/create
 *
 * ### Azure-to-Azure Disaster Recovery
 * **Example:** Pair the primary and recovery containers
 * ```typescript
 * const mapping = yield* Azure.SiteRecovery.ProtectionContainerMapping(
 *   "primary-to-recovery",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     vault: vault.vaultName,
 *     fabric: primary.fabricName,
 *     protectionContainer: primaryContainer.protectionContainerName,
 *     targetProtectionContainerId: recoveryContainer.protectionContainerId,
 *     policyId: policy.policyId,
 *     providerSpecificInput: {
 *       instanceType: "A2A",
 *       agentAutoUpdateStatus: "Disabled",
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 */
export const ProtectionContainerMapping = Resource<ProtectionContainerMapping>(
  "Azure.SiteRecovery.ProtectionContainerMapping",
);

type Observed = asr.GetReplicationProtectionContainerMappingResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  resourceName: string;
  fabricName: string;
  protectionContainerName: string;
  mappingName: string;
}

const getMapping = (where: Where) =>
  orUndefinedIfNotFound(asr.GetReplicationProtectionContainerMapping(where));

const detailsOf = (observed: Observed) =>
  (observed.properties?.providerSpecificDetails ?? {}) as Record<
    string,
    unknown
  >;

const DEFAULT_INPUT: ProtectionContainerMappingProviderInput = {
  instanceType: "A2A",
};

/** Mutable provider settings (everything but the discriminator). */
const mutableSettings = (input: ProtectionContainerMappingProviderInput) => {
  const { instanceType: _, ...rest } = input;
  return rest;
};

/** Pairing completes asynchronously: `Paired` is ready, `*Failed` is terminal. */
const pairingState = (observed: Observed) => {
  const state = observed.properties?.state;
  if (state === undefined || state === "Paired") return undefined;
  return /failed/i.test(state) ? "Failed" : state;
};

const toAttrs = (
  props: ProtectionContainerMappingProps,
  name: string,
  observed: Observed,
): ProtectionContainerMapping["Attributes"] => ({
  mappingName: name,
  protectionContainer: props.protectionContainer,
  fabric: props.fabric,
  vault: props.vault,
  resourceGroup: props.resourceGroup,
  mappingId: observed.id ?? "",
  targetProtectionContainerId:
    observed.properties?.targetProtectionContainerId ??
    props.targetProtectionContainerId,
  policyId: observed.properties?.policyId ?? props.policyId,
  state: observed.properties?.state,
  health: observed.properties?.health,
  providerSpecificDetails: detailsOf(observed),
});

export const ProtectionContainerMappingProvider = () =>
  Provider.succeed(ProtectionContainerMapping, {
    stables: [
      "mappingName",
      "protectionContainer",
      "fabric",
      "vault",
      "resourceGroup",
      "mappingId",
    ],

    // Mappings live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        !sameName(news.fabric, output.fabric) ||
        !sameName(news.protectionContainer, output.protectionContainer) ||
        (news.name !== undefined && !sameName(news.name, output.mappingName)) ||
        !sameName(
          news.targetProtectionContainerId,
          output.targetProtectionContainerId,
        ) ||
        !sameName(news.policyId, output.policyId) ||
        (olds !== undefined &&
          !sameName(
            (news.providerSpecificInput ?? DEFAULT_INPUT).instanceType,
            (olds.providerSpecificInput ?? DEFAULT_INPUT).instanceType,
          ))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const props = output ?? olds;
      if (props === undefined) return undefined;
      const resourceGroup = props.resourceGroup;
      const name =
        output?.mappingName ??
        olds?.name ??
        (yield* createSiteRecoveryName(id));
      const observed = yield* getMapping({
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: props.vault,
        fabricName: props.fabric,
        protectionContainerName: props.protectionContainer,
        mappingName: name,
      });
      if (observed === undefined) return undefined;
      return yield* ownedOrUnowned(
        toAttrs(
          {
            resourceGroup,
            vault: props.vault,
            fabric: props.fabric,
            protectionContainer: props.protectionContainer,
            targetProtectionContainerId: props.targetProtectionContainerId,
            policyId: props.policyId,
          },
          name,
          observed,
        ),
        output !== undefined,
        subscriptionId,
        resourceGroup,
        props.vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SITE_RECOVERY_NAMESPACE);
      const name =
        news.name ?? output?.mappingName ?? (yield* createSiteRecoveryName(id));
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        resourceName: news.vault,
        fabricName: news.fabric,
        protectionContainerName: news.protectionContainer,
        mappingName: name,
      };
      const input = news.providerSpecificInput ?? DEFAULT_INPUT;
      const get = getMapping(where);

      // Observe.
      let observed = yield* get;

      // Ensure: pair the containers when missing, then wait for `Paired`.
      if (observed === undefined) {
        yield* asr.CreateReplicationProtectionContainerMapping({
          ...where,
          properties: {
            targetProtectionContainerId: news.targetProtectionContainerId,
            policyId: news.policyId,
            providerSpecificInput: input,
          },
        });
      }
      observed = yield* waitForProvisioned(
        `site recovery container mapping ${name}`,
        get,
        pairingState,
        { interval: "10 seconds", times: 48 },
      );

      // Sync: agent auto-update settings against the observed mapping.
      const desired = mutableSettings(input);
      if (
        Object.keys(desired).length > 0 &&
        !matchesDesired(detailsOf(observed), desired)
      ) {
        yield* asr.UpdateReplicationProtectionContainerMapping({
          ...where,
          properties: { providerSpecificInput: input },
        });
        observed = yield* waitForProvisioned(
          `site recovery container mapping ${name}`,
          get,
          (mapping) =>
            matchesDesired(detailsOf(mapping), desired)
              ? pairingState(mapping)
              : "Updating",
          { interval: "10 seconds", times: 48 },
        );
      }
      return toAttrs(news, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        resourceName: output.vault,
        fabricName: output.fabric,
        protectionContainerName: output.protectionContainer,
        mappingName: output.mappingName,
      };
      // Graceful unpair (POST .../remove); protected items are removed first.
      yield* ignoreNotFound(
        asr.DeleteReplicationProtectionContainerMapping({
          ...where,
          properties: {},
        }),
      );
      yield* waitUntilGone(
        `site recovery container mapping ${output.mappingName}`,
        getMapping(where),
        { interval: "10 seconds", times: 48 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.SiteRecovery.ProtectedItem",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
