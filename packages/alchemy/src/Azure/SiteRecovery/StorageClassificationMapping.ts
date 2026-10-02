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
  ownedOrUnowned,
  sameName,
  SITE_RECOVERY_NAMESPACE,
} from "./Shared.ts";

export interface StorageClassificationMappingProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the mapping. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the mapping. */
  vault: string;
  /** Name of the primary fabric. Changing it replaces the mapping. */
  fabric: string;
  /**
   * Name of the source storage classification (discovered from the VMM
   * server). Changing it replaces the mapping.
   */
  storageClassification: string;
  /**
   * Mapping name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the mapping.
   */
  name?: string;
  /** ARM ID of the target storage classification. Changing it replaces the mapping. */
  targetStorageClassificationId: string;
}

export interface StorageClassificationMapping extends Resource<
  "Azure.SiteRecovery.StorageClassificationMapping",
  StorageClassificationMappingProps,
  {
    /** Name of the mapping. */
    storageClassificationMappingName: string;
    /** Name of the source storage classification. */
    storageClassification: string;
    /** Name of the primary fabric. */
    fabric: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the mapping. */
    storageClassificationMappingId: string;
    /** ARM ID of the target storage classification. */
    targetStorageClassificationId: string;
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery storage classification mapping: maps a storage
 * classification of a VMM-managed Hyper-V site to a target classification
 * used on failover.
 *
 * Storage classifications are discovered from an on-premises System Center
 * VMM server registered with the vault, so this resource only applies to
 * VMM-to-VMM or VMM-to-Azure scenarios. Mappings cannot be tagged;
 * Alchemy treats a mapping as owned when its vault is tagged for the
 * current stack and stage. Every change replaces the mapping.
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-storage-classification-mappings/create
 *
 * ### VMM Sites
 * **Example:** Map a gold storage tier to its recovery counterpart
 * ```typescript
 * yield* Azure.SiteRecovery.StorageClassificationMapping("gold", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   fabric: "vmm-primary",
 *   storageClassification: "gold-primary",
 *   targetStorageClassificationId: goldRecoveryClassificationId,
 * });
 * ```
 *
 * @resource
 */
export const StorageClassificationMapping =
  Resource<StorageClassificationMapping>(
    "Azure.SiteRecovery.StorageClassificationMapping",
  );

type Observed = asr.GetReplicationStorageClassificationMappingResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  resourceName: string;
  fabricName: string;
  storageClassificationName: string;
  storageClassificationMappingName: string;
}

const getMapping = (where: Where) =>
  orUndefinedIfNotFound(asr.GetReplicationStorageClassificationMapping(where));

const toAttrs = (
  where: Where,
  observed: Observed,
  targetStorageClassificationId: string,
): StorageClassificationMapping["Attributes"] => ({
  storageClassificationMappingName: where.storageClassificationMappingName,
  storageClassification: where.storageClassificationName,
  fabric: where.fabricName,
  vault: where.resourceName,
  resourceGroup: where.resourceGroupName,
  storageClassificationMappingId: observed.id ?? "",
  targetStorageClassificationId:
    observed.properties?.targetStorageClassificationId ??
    targetStorageClassificationId,
});

export const StorageClassificationMappingProvider = () =>
  Provider.succeed(StorageClassificationMapping, {
    stables: [
      "storageClassificationMappingName",
      "storageClassification",
      "fabric",
      "vault",
      "resourceGroup",
      "storageClassificationMappingId",
      "targetStorageClassificationId",
    ],

    // Mappings live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        !sameName(news.fabric, output.fabric) ||
        !sameName(news.storageClassification, output.storageClassification) ||
        (news.name !== undefined &&
          !sameName(news.name, output.storageClassificationMappingName)) ||
        !sameName(
          news.targetStorageClassificationId,
          output.targetStorageClassificationId,
        )
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const props = output ?? olds;
      if (props === undefined) return undefined;
      const where: Where = {
        subscriptionId,
        resourceGroupName: props.resourceGroup,
        resourceName: props.vault,
        fabricName: props.fabric,
        storageClassificationName: props.storageClassification,
        storageClassificationMappingName:
          output?.storageClassificationMappingName ??
          olds?.name ??
          (yield* createSiteRecoveryName(id)),
      };
      const observed = yield* getMapping(where);
      if (observed === undefined) return undefined;
      return yield* ownedOrUnowned(
        toAttrs(where, observed, props.targetStorageClassificationId),
        output !== undefined,
        subscriptionId,
        props.resourceGroup,
        props.vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SITE_RECOVERY_NAMESPACE);
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        resourceName: news.vault,
        fabricName: news.fabric,
        storageClassificationName: news.storageClassification,
        storageClassificationMappingName:
          news.name ??
          output?.storageClassificationMappingName ??
          (yield* createSiteRecoveryName(id)),
      };
      const get = getMapping(where);

      // Observe; ensure (every input is immutable).
      const observed = yield* get;
      if (observed === undefined) {
        yield* asr.CreateReplicationStorageClassificationMapping({
          ...where,
          properties: {
            targetStorageClassificationId: news.targetStorageClassificationId,
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `site recovery storage classification mapping ${where.storageClassificationMappingName}`,
        get,
        () => undefined,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(where, fresh, news.targetStorageClassificationId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        resourceName: output.vault,
        fabricName: output.fabric,
        storageClassificationName: output.storageClassification,
        storageClassificationMappingName:
          output.storageClassificationMappingName,
      };
      yield* ignoreNotFound(
        asr.DeleteReplicationStorageClassificationMapping(where),
      );
      yield* waitUntilGone(
        `site recovery storage classification mapping ${output.storageClassificationMappingName}`,
        getMapping(where),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
