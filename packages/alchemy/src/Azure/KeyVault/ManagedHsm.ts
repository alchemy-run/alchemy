import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createVaultName, lower } from "./common.ts";

export type ManagedHsmSkuName = keyvault.ManagedHsmSkuName;

/** Firewall rules for a managed HSM. */
export interface ManagedHsmNetworkAcls {
  /**
   * Traffic that bypasses the rules.
   * @default "AzureServices"
   */
  bypass?: "AzureServices" | "None";
  /**
   * Action when no rule matches.
   * @default "Allow"
   */
  defaultAction?: "Allow" | "Deny";
  /** Allowed public IPv4 addresses or CIDR ranges. */
  ipRules?: string[];
  /** Allowed service tags. */
  serviceTags?: string[];
  /** Allowed subnet IDs. */
  virtualNetworkRules?: string[];
}

export interface ManagedHsmProps {
  /** Resource group the HSM is created in. Changing it replaces the HSM. */
  resourceGroup: string;
  /**
   * Globally unique HSM name (`{name}.managedhsm.azure.net`): 3-24
   * letters, digits, and hyphens. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the HSM.
   */
  name?: string;
  /**
   * Azure location of the HSM. Changing it replaces the HSM.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * HSM pool SKU. Changing it replaces the HSM.
   * @default "Standard_B1"
   */
  sku?: ManagedHsmSkuName;
  /**
   * Entra tenant of the HSM. Changing it replaces the HSM.
   * @default the deploying credential's tenant
   */
  tenantId?: string;
  /**
   * Object IDs of the initial administrators, who can download the
   * security domain and activate the HSM.
   */
  initialAdminObjectIds: string[];
  /**
   * Days a deleted HSM stays recoverable, 7-90. Changing it replaces the HSM.
   * @default 90
   */
  softDeleteRetentionInDays?: number;
  /**
   * Prevent purging until the retention period ends. Irreversible.
   * @default false
   */
  enablePurgeProtection?: boolean;
  /**
   * Purge the soft-deleted HSM after deleting it. A soft-deleted HSM keeps
   * being billed until it is purged. Ignored with purge protection.
   * @default true
   */
  purgeOnDelete?: boolean;
  /**
   * Firewall rules.
   * @default unmanaged
   */
  networkAcls?: ManagedHsmNetworkAcls;
  /**
   * Whether the public endpoint accepts traffic.
   * @default unmanaged (Azure's default is `Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ManagedHsm extends Resource<
  "Azure.KeyVault.ManagedHsm",
  ManagedHsmProps,
  {
    /** Name of the HSM. */
    managedHsmName: string;
    /** ARM resource ID of the HSM. */
    managedHsmId: string;
    /** Data-plane endpoint, e.g. `https://{name}.managedhsm.azure.net/`. */
    hsmUri: string;
    /** Resource group that holds the HSM. */
    resourceGroup: string;
    /** Location of the HSM. */
    location: string;
    /** Entra tenant of the HSM. */
    tenantId: string;
    /** SKU name. */
    sku: string;
    /** Soft-delete retention in days. */
    softDeleteRetentionInDays: number;
    /** Whether purge protection is enabled. */
    enablePurgeProtection: boolean;
    /** Whether destroy purges the soft-deleted HSM. */
    purgeOnDelete: boolean;
    /** Security domain activation status (`NotActivated` until activated). */
    activationStatus: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Key Vault Managed HSM: a single-tenant, FIPS 140-3 Level 3
 * validated HSM pool.
 *
 * Provisioning takes 20-30 minutes and the pool is billed hourly (about
 * $3.20/hour for `Standard_B1`) until it is deleted *and* purged. The HSM is
 * unusable until an administrator downloads its security domain (a
 * data-plane step outside this resource).
 *
 * @see https://learn.microsoft.com/azure/key-vault/managed-hsm/overview
 *
 * ### Creating a Managed HSM
 * **Example:** Standard HSM pool
 * ```typescript
 * const hsm = yield* Azure.KeyVault.ManagedHsm("hsm", {
 *   resourceGroup: group.resourceGroupName,
 *   initialAdminObjectIds: [adminObjectId],
 *   softDeleteRetentionInDays: 7,
 * });
 * ```
 *
 * ### Network Rules
 * **Example:** Private-only HSM
 * ```typescript
 * const hsm = yield* Azure.KeyVault.ManagedHsm("hsm", {
 *   resourceGroup: group.resourceGroupName,
 *   initialAdminObjectIds: [adminObjectId],
 *   publicNetworkAccess: "Disabled",
 *   networkAcls: { defaultAction: "Deny" },
 * });
 * ```
 *
 * @resource
 */
export const ManagedHsm = Resource<ManagedHsm>("Azure.KeyVault.ManagedHsm");

type ObservedHsm = keyvault.GetManagedHsmResponse;

const getManagedHsm = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    keyvault.GetManagedHsm({ subscriptionId, resourceGroupName, name }),
  );

const getDeletedHsm = (
  subscriptionId: string,
  location: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    keyvault.GetManagedHsmDeleted({ subscriptionId, location, name }),
  );

const skuFamily = (sku: string) => (sku.startsWith("Custom_C") ? "C" : "B");

const toAttrs = (
  resourceGroup: string,
  name: string,
  hsm: ObservedHsm,
  purgeOnDelete: boolean,
): ManagedHsm["Attributes"] => ({
  managedHsmName: name,
  managedHsmId: hsm.id ?? "",
  hsmUri: hsm.properties?.hsmUri ?? `https://${name}.managedhsm.azure.net/`,
  resourceGroup,
  location: hsm.location ?? "",
  tenantId: hsm.properties?.tenantId ?? "",
  sku: hsm.sku?.name ?? "",
  softDeleteRetentionInDays: hsm.properties?.softDeleteRetentionInDays ?? 90,
  enablePurgeProtection: hsm.properties?.enablePurgeProtection ?? false,
  purgeOnDelete,
  activationStatus: hsm.properties?.securityDomainProperties?.activationStatus,
  tags: userTags(hsm.tags),
});

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].map((v) => v.toLowerCase()).sort();

const cidr = (value: string) => (value.includes("/") ? value : `${value}/32`);

const normalizeAcls = (acls: keyvault.MHSMNetworkRuleSet | undefined) =>
  JSON.stringify({
    bypass: acls?.bypass ?? "AzureServices",
    defaultAction: acls?.defaultAction ?? "Allow",
    ipRules: sorted((acls?.ipRules ?? []).map((rule) => cidr(rule.value))),
    serviceTags: sorted((acls?.serviceTags ?? []).map((rule) => rule.tag)),
    vnet: sorted((acls?.virtualNetworkRules ?? []).map((rule) => rule.id)),
  });

const toRuleSet = (
  acls: ManagedHsmNetworkAcls,
): keyvault.MHSMNetworkRuleSet => ({
  bypass: acls.bypass ?? "AzureServices",
  defaultAction: acls.defaultAction ?? "Allow",
  ipRules: (acls.ipRules ?? []).map((value) => ({ value })),
  serviceTags: (acls.serviceTags ?? []).map((tag) => ({ tag })),
  virtualNetworkRules: (acls.virtualNetworkRules ?? []).map((id) => ({ id })),
});

/** The pool rejects updates and soft delete while it applies a change. */
const whilePoolUpdating = {
  while: (e: { readonly _tag: string }) => e._tag === "ManagedHsmPoolUpdating",
  schedule: Schedule.spaced("15 seconds"),
  times: 40,
} as const;

export const ManagedHsmProvider = () =>
  Provider.succeed(ManagedHsm, {
    stables: [
      "managedHsmName",
      "managedHsmId",
      "hsmUri",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* keyvault
        .ListManagedHsmBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListManagedHsmBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((hsm) => {
        const group = resourceGroupOf(hsm.id);
        return hasAnyAlchemyTag(hsm.tags) &&
          group !== undefined &&
          hsm.name !== undefined
          ? [toAttrs(group, hsm.name, hsm as ObservedHsm, true)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.managedHsmName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (news.sku ?? "Standard_B1") !== output.sku ||
        (news.tenantId !== undefined &&
          lower(news.tenantId) !== lower(output.tenantId)) ||
        (news.softDeleteRetentionInDays ?? 90) !==
          output.softDeleteRetentionInDays
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.managedHsmName ?? olds?.name ?? (yield* createVaultName(id));
      const observed = yield* getManagedHsm(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        output?.purgeOnDelete ?? olds?.purgeOnDelete ?? true,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.KeyVault");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.managedHsmName ?? (yield* createVaultName(id));
      const location = news.location ?? output?.location ?? env.location;
      const sku = news.sku ?? "Standard_B1";
      const tags = yield* desiredTags(id, news.tags);
      const networkAcls =
        news.networkAcls === undefined
          ? undefined
          : toRuleSet(news.networkAcls);
      const where = { subscriptionId, resourceGroupName: resourceGroup, name };
      const label = `managed HSM ${name}`;
      const get = getManagedHsm(subscriptionId, resourceGroup, name);
      // Provisioning takes 20-30 minutes; allow up to 45.
      const budget = { interval: "30 seconds", times: 90 } as const;

      // Observe.
      let observed = yield* get;

      // Ensure (long-running). A soft-deleted HSM of ours is recovered.
      if (observed === undefined) {
        const deleted = yield* getDeletedHsm(subscriptionId, location, name);
        const recover =
          deleted !== undefined &&
          (yield* isOwned(id, deleted.properties?.tags));
        yield* keyvault
          .ManagedHsmsCreateOrUpdate({
            ...where,
            location,
            sku: { family: skuFamily(sku), name: sku },
            tags,
            properties: recover
              ? { createMode: "recover" }
              : {
                  tenantId: news.tenantId ?? env.tenantId,
                  initialAdminObjectIds: news.initialAdminObjectIds,
                  softDeleteRetentionInDays:
                    news.softDeleteRetentionInDays ?? 90,
                  enablePurgeProtection: news.enablePurgeProtection ?? false,
                  networkAcls,
                  publicNetworkAccess: news.publicNetworkAccess,
                },
          })
          .pipe(
            // A just-created resource group can take a few seconds to
            // replicate to the Key Vault RP.
            Effect.retry({
              while: (e) => e._tag === "ResourceGroupNotFound",
              schedule: Schedule.spaced("5 seconds"),
              times: 12,
            }),
          );
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (hsm) => hsm.properties?.provisioningState,
        budget,
      );

      // Sync mutable aspects against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const changed: keyvault.ManagedHsmPropertiesInput = {};
      if (
        JSON.stringify(sorted(props.initialAdminObjectIds)) !==
        JSON.stringify(sorted(news.initialAdminObjectIds))
      ) {
        changed.initialAdminObjectIds = news.initialAdminObjectIds;
      }
      if (news.enablePurgeProtection && !props.enablePurgeProtection) {
        changed.enablePurgeProtection = true;
      }
      if (
        networkAcls !== undefined &&
        normalizeAcls(props.networkAcls) !== normalizeAcls(networkAcls)
      ) {
        changed.networkAcls = networkAcls;
      }
      if (
        news.publicNetworkAccess !== undefined &&
        (props.publicNetworkAccess ?? "Enabled") !== news.publicNetworkAccess
      ) {
        changed.publicNetworkAccess = news.publicNetworkAccess;
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || tagsChanged) {
        yield* keyvault
          .UpdateManagedHsm({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          })
          .pipe(Effect.retry(whilePoolUpdating));
        observed = yield* waitForProvisioned(
          label,
          get,
          (hsm) => hsm.properties?.provisioningState,
          budget,
        );
      }

      return toAttrs(resourceGroup, name, observed, news.purgeOnDelete ?? true);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.managedHsmName;
      yield* ignoreNotFound(
        keyvault
          .DeleteManagedHsm({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            name,
          })
          .pipe(Effect.retry(whilePoolUpdating)),
      );
      yield* waitUntilGone(
        `managed HSM ${name}`,
        getManagedHsm(subscriptionId, output.resourceGroup, name),
        { interval: "15 seconds", times: 60 },
      );
      if (output.purgeOnDelete === false || output.enablePurgeProtection) {
        return;
      }
      // A purge already in flight (e.g. from an interrupted destroy) is
      // awaited rather than restarted.
      yield* ignoreNotFound(
        keyvault
          .PurgeManagedHsmDeleted({
            subscriptionId,
            location: output.location,
            name,
          })
          .pipe(
            Effect.catchTag("ManagedHsmAlreadyBeingDeleted", () => Effect.void),
          ),
      );
      // Purging a never-activated pool has been observed to take 30+ minutes.
      yield* waitUntilGone(
        `deleted managed HSM ${name}`,
        getDeletedHsm(subscriptionId, output.location, name),
        { interval: "30 seconds", times: 120 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
