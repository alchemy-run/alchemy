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

export interface FabricProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the fabric. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the fabric. */
  vault: string;
  /**
   * Fabric name, unique within the vault. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * fabric.
   */
  name?: string;
  /**
   * Azure region this `Azure` (Azure-to-Azure) fabric represents, e.g.
   * `eastus`. One fabric per region per vault. Changing it replaces the
   * fabric.
   * @default the Azure environment's location
   */
  location?: string;
}

export interface Fabric extends Resource<
  "Azure.SiteRecovery.Fabric",
  FabricProps,
  {
    /** Name of the fabric. */
    fabricName: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the fabric; pass it as a recovery plan's fabric ID. */
    fabricId: string;
    /** Azure region the fabric represents. */
    location: string;
    /** Friendly name Azure assigned, e.g. `East US`. */
    friendlyName: string | undefined;
    /** Fabric health, e.g. `Normal`. */
    health: string | undefined;
    /** Internal identifier Azure assigned to the fabric. */
    internalIdentifier: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery fabric: the site container for a region in a
 * Recovery Services vault. Azure-to-Azure disaster recovery needs one
 * `Azure` fabric for the primary region and one for the recovery region.
 *
 * Fabrics cannot be tagged; Alchemy treats a fabric as owned when its
 * vault is tagged for the current stack and stage. Creating a fabric runs
 * an ASR job that takes about three minutes; removing it is graceful (the
 * fabric's protection containers are removed first).
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-fabrics/create
 *
 * ### Azure-to-Azure Disaster Recovery
 * **Example:** Primary and recovery fabrics
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("dr-vault", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus2",
 * });
 * const primary = yield* Azure.SiteRecovery.Fabric("primary", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   location: "eastus",
 * });
 * const recovery = yield* Azure.SiteRecovery.Fabric("recovery", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   location: "westus2",
 * });
 * ```
 *
 * @resource
 */
export const Fabric = Resource<Fabric>("Azure.SiteRecovery.Fabric");

type Observed = asr.GetReplicationFabricResponse;

const getFabric = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  fabricName: string,
) =>
  orUndefinedIfNotFound(
    asr.GetReplicationFabric({
      subscriptionId,
      resourceGroupName,
      resourceName,
      fabricName,
    }),
  );

const locationOf = (observed: Observed) =>
  (observed.properties?.customDetails as { location?: string } | undefined)
    ?.location;

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  location: string,
  observed: Observed,
): Fabric["Attributes"] => ({
  fabricName: name,
  vault,
  resourceGroup,
  fabricId: observed.id ?? "",
  location: locationOf(observed) ?? location,
  friendlyName: observed.properties?.friendlyName,
  health: observed.properties?.health,
  internalIdentifier: observed.properties?.internalIdentifier,
});

export const FabricProvider = () =>
  Provider.succeed(Fabric, {
    stables: ["fabricName", "vault", "resourceGroup", "fabricId", "location"],

    // Fabrics live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        (news.name !== undefined && !sameName(news.name, output.fabricName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId, location } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      if (resourceGroup === undefined || vault === undefined) return undefined;
      const name =
        output?.fabricName ?? olds?.name ?? (yield* createSiteRecoveryName(id));
      const observed = yield* getFabric(
        subscriptionId,
        resourceGroup,
        vault,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        vault,
        name,
        olds?.location ?? location,
        observed,
      );
      return yield* ownedOrUnowned(
        attrs,
        output !== undefined,
        subscriptionId,
        resourceGroup,
        vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, SITE_RECOVERY_NAMESPACE);
      const { resourceGroup, vault } = news;
      const location = news.location ?? env.location;
      const name =
        news.name ?? output?.fabricName ?? (yield* createSiteRecoveryName(id));
      const get = getFabric(subscriptionId, resourceGroup, vault, name);

      // Observe.
      const observed = yield* get;

      // Ensure: nothing on a fabric is mutable, so the PUT only runs when
      // it is missing. The create job takes ~3 minutes before GET sees it.
      if (observed === undefined) {
        yield* asr.CreateReplicationFabric({
          subscriptionId,
          resourceGroupName: resourceGroup,
          resourceName: vault,
          fabricName: name,
          properties: { customDetails: { instanceType: "Azure", location } },
        });
      }
      const fresh = yield* waitForProvisioned(
        `site recovery fabric ${name}`,
        get,
        () => undefined,
        { interval: "10 seconds", times: 54 },
      );
      return toAttrs(resourceGroup, vault, name, location, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Graceful removal (POST .../remove); containers are removed first.
      yield* ignoreNotFound(
        asr.DeleteReplicationFabric({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.vault,
          fabricName: output.fabricName,
        }),
      );
      yield* waitUntilGone(
        `site recovery fabric ${output.fabricName}`,
        getFabric(
          subscriptionId,
          output.resourceGroup,
          output.vault,
          output.fabricName,
        ),
        { interval: "10 seconds", times: 54 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.SiteRecovery.ProtectionContainer",
        "Azure.RecoveryServices.Vault",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
