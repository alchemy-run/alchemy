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

/** Provider-specific container creation input, e.g. `{ instanceType: "A2A" }`. */
export interface ProtectionContainerProviderInput {
  /** Replication provider: `A2A` (Azure-to-Azure), `A2ACrossClusterMigration`, `VMwareCbt`. */
  instanceType: string;
  /** Any other provider field. */
  [key: string]: unknown;
}

export interface ProtectionContainerProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the container. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the container. */
  vault: string;
  /** Name of the fabric that holds the container. Changing it replaces the container. */
  fabric: string;
  /**
   * Container name, unique within the fabric. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * container.
   */
  name?: string;
  /**
   * Provider-specific creation inputs. Changing them replaces the container.
   * @default [{ instanceType: "A2A" }]
   */
  providerSpecificInput?: ProtectionContainerProviderInput[];
}

export interface ProtectionContainer extends Resource<
  "Azure.SiteRecovery.ProtectionContainer",
  ProtectionContainerProps,
  {
    /** Name of the protection container. */
    protectionContainerName: string;
    /** Name of the fabric. */
    fabric: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the container; pass it as a mapping's target container. */
    protectionContainerId: string;
    /** Fabric type, e.g. `Azure`. */
    fabricType: string | undefined;
    /** Pairing status, e.g. `NotPaired` or `Paired`. */
    pairingStatus: string | undefined;
    /** Number of protected items in the container. */
    protectedItemCount: number;
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery protection container inside a fabric. Protected
 * items live in a container, and a container mapping pairs a primary
 * container with a recovery container under a replication policy.
 *
 * Containers cannot be tagged; Alchemy treats a container as owned when
 * its vault is tagged for the current stack and stage. Every input is
 * immutable, so changing one replaces the container. Delete is the
 * graceful `remove` operation.
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-protection-containers/create
 *
 * ### Azure-to-Azure Disaster Recovery
 * **Example:** A2A container in a fabric
 * ```typescript
 * const container = yield* Azure.SiteRecovery.ProtectionContainer("primary", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   fabric: primary.fabricName,
 * });
 * ```
 *
 * @resource
 */
export const ProtectionContainer = Resource<ProtectionContainer>(
  "Azure.SiteRecovery.ProtectionContainer",
);

type Observed = asr.GetReplicationProtectionContainerResponse;

const getContainer = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  fabricName: string,
  protectionContainerName: string,
) =>
  orUndefinedIfNotFound(
    asr.GetReplicationProtectionContainer({
      subscriptionId,
      resourceGroupName,
      resourceName,
      fabricName,
      protectionContainerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  vault: string,
  fabric: string,
  name: string,
  observed: Observed,
): ProtectionContainer["Attributes"] => ({
  protectionContainerName: name,
  fabric,
  vault,
  resourceGroup,
  protectionContainerId: observed.id ?? "",
  fabricType: observed.properties?.fabricType,
  pairingStatus: observed.properties?.pairingStatus,
  protectedItemCount: observed.properties?.protectedItemCount ?? 0,
});

export const ProtectionContainerProvider = () =>
  Provider.succeed(ProtectionContainer, {
    stables: [
      "protectionContainerName",
      "fabric",
      "vault",
      "resourceGroup",
      "protectionContainerId",
    ],

    // Containers live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        !sameName(news.fabric, output.fabric) ||
        (news.name !== undefined &&
          !sameName(news.name, output.protectionContainerName)) ||
        (olds !== undefined &&
          JSON.stringify(news.providerSpecificInput ?? null) !==
            JSON.stringify(olds.providerSpecificInput ?? null))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      const fabric = output?.fabric ?? olds?.fabric;
      if (!resourceGroup || !vault || !fabric) return undefined;
      const name =
        output?.protectionContainerName ??
        olds?.name ??
        (yield* createSiteRecoveryName(id));
      const observed = yield* getContainer(
        subscriptionId,
        resourceGroup,
        vault,
        fabric,
        name,
      );
      if (observed === undefined) return undefined;
      return yield* ownedOrUnowned(
        toAttrs(resourceGroup, vault, fabric, name, observed),
        output !== undefined,
        subscriptionId,
        resourceGroup,
        vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SITE_RECOVERY_NAMESPACE);
      const { resourceGroup, vault, fabric } = news;
      const name =
        news.name ??
        output?.protectionContainerName ??
        (yield* createSiteRecoveryName(id));
      const get = getContainer(
        subscriptionId,
        resourceGroup,
        vault,
        fabric,
        name,
      );

      // Observe; ensure (nothing is mutable after creation).
      const observed = yield* get;
      if (observed === undefined) {
        yield* asr.CreateReplicationProtectionContainer({
          subscriptionId,
          resourceGroupName: resourceGroup,
          resourceName: vault,
          fabricName: fabric,
          protectionContainerName: name,
          properties: {
            providerSpecificInput: news.providerSpecificInput ?? [
              { instanceType: "A2A" },
            ],
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `site recovery protection container ${name}`,
        get,
        () => undefined,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, vault, fabric, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Graceful removal (POST .../remove); mappings are removed first.
      yield* ignoreNotFound(
        asr.DeleteReplicationProtectionContainer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.vault,
          fabricName: output.fabric,
          protectionContainerName: output.protectionContainerName,
        }),
      );
      yield* waitUntilGone(
        `site recovery protection container ${output.protectionContainerName}`,
        getContainer(
          subscriptionId,
          output.resourceGroup,
          output.vault,
          output.fabric,
          output.protectionContainerName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.SiteRecovery.ProtectionContainerMapping",
        "Azure.SiteRecovery.ProtectedItem",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
