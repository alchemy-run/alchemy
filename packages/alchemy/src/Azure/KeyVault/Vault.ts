import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as Effect from "effect/Effect";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createVaultName, getDeletedVault, getVault, lower } from "./common.ts";

export type VaultSkuName = "standard" | "premium";

/** Data-plane permissions granted by an access policy. */
export interface VaultPermissions {
  /** Key permissions, e.g. `get`, `list`, `create`, `wrapKey`, or `all`. */
  keys?: keyvault.KeyPermissions[];
  /** Secret permissions, e.g. `get`, `list`, `set`, or `all`. */
  secrets?: keyvault.SecretPermissions[];
  /** Certificate permissions, e.g. `get`, `list`, `create`, or `all`. */
  certificates?: keyvault.CertificatePermissions[];
  /** Managed storage account permissions. */
  storage?: keyvault.StoragePermissions[];
}

/** An identity granted data-plane access to a vault (access-policy mode). */
export interface VaultAccessPolicyEntry {
  /**
   * Entra tenant of the identity.
   * @default the vault's tenant
   */
  tenantId?: string;
  /** Object ID of the user, service principal, or group. */
  objectId: string;
  /** Application ID of a client acting on behalf of the principal. */
  applicationId?: string;
  /** Permissions granted to the identity. */
  permissions: VaultPermissions;
}

/** Firewall rules for a vault. */
export interface VaultNetworkAcls {
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
  /** Allowed subnet IDs (the subnet needs a `Microsoft.KeyVault` service endpoint). */
  virtualNetworkRules?: string[];
}

export interface VaultProps {
  /** Resource group the vault is created in. Changing it replaces the vault. */
  resourceGroup: string;
  /**
   * Globally unique vault name (`{name}.vault.azure.net`): 3-24 letters,
   * digits, and hyphens, starting with a letter. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the vault.
   */
  name?: string;
  /**
   * Azure location of the vault. Changing it replaces the vault.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. `premium` adds HSM-protected keys.
   * @default "standard"
   */
  sku?: VaultSkuName;
  /**
   * Entra tenant that authenticates data-plane requests.
   * @default the deploying credential's tenant
   */
  tenantId?: string;
  /**
   * Authorize data-plane access with Azure RBAC role assignments instead of
   * access policies. When `true`, access policies are ignored.
   * @default true
   */
  enableRbacAuthorization?: boolean;
  /**
   * Access policies of the vault (only used when
   * `enableRbacAuthorization` is `false`). When set, the list is managed
   * exactly; when omitted, existing policies are left alone so standalone
   * `Azure.KeyVault.AccessPolicy` resources can manage them. Do not combine
   * both on one vault.
   * @default unmanaged
   */
  accessPolicies?: VaultAccessPolicyEntry[];
  /**
   * Allow Azure VMs to retrieve certificates stored as secrets.
   * @default unmanaged (Azure's default is `false`)
   */
  enabledForDeployment?: boolean;
  /**
   * Allow Azure Disk Encryption to retrieve secrets and unwrap keys.
   * @default unmanaged (Azure's default is `false`)
   */
  enabledForDiskEncryption?: boolean;
  /**
   * Allow Azure Resource Manager deployments to retrieve secrets.
   * @default unmanaged (Azure's default is `false`)
   */
  enabledForTemplateDeployment?: boolean;
  /**
   * Days a deleted vault (and deleted keys/secrets) stays recoverable,
   * 7-90. Fixed at creation; changing it replaces the vault.
   * @default 90
   */
  softDeleteRetentionInDays?: number;
  /**
   * Prevent purging deleted vaults and objects until the retention period
   * ends. Irreversible: once enabled it cannot be turned off, and a
   * destroyed vault keeps its name reserved until retention ends.
   * @default false
   */
  enablePurgeProtection?: boolean;
  /**
   * Purge the soft-deleted vault after deleting it, which frees the name
   * immediately. Ignored when purge protection is enabled.
   * @default true
   */
  purgeOnDelete?: boolean;
  /**
   * Firewall rules.
   * @default unmanaged (Azure's default allows all networks)
   */
  networkAcls?: VaultNetworkAcls;
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

export interface Vault extends Resource<
  "Azure.KeyVault.Vault",
  VaultProps,
  {
    /** Name of the vault. */
    vaultName: string;
    /** ARM resource ID of the vault; use it as a role-assignment scope. */
    vaultId: string;
    /** Data-plane endpoint, e.g. `https://{name}.vault.azure.net/`. */
    vaultUri: string;
    /** Resource group that holds the vault. */
    resourceGroup: string;
    /** Location of the vault. */
    location: string;
    /** Entra tenant of the vault. */
    tenantId: string;
    /** Pricing tier. */
    sku: string;
    /** Whether data-plane access uses Azure RBAC. */
    enableRbacAuthorization: boolean;
    /** Soft-delete retention in days. */
    softDeleteRetentionInDays: number;
    /** Whether purge protection is enabled. */
    enablePurgeProtection: boolean;
    /** Whether destroy purges the soft-deleted vault. */
    purgeOnDelete: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Key Vault for keys, secrets, and certificates.
 *
 * Vaults use Azure RBAC for data-plane access by default and keep 90 days
 * of soft-delete. Destroying a vault deletes it and then purges it so the
 * name can be reused right away (set `purgeOnDelete: false` to keep the
 * soft-deleted vault recoverable).
 *
 * @see https://learn.microsoft.com/azure/key-vault/general/overview
 *
 * ### Creating a Vault
 * **Example:** RBAC-authorized vault
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const vault = yield* Azure.KeyVault.Vault("secrets", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Premium vault with short soft-delete retention
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("hsm-keys", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "premium",
 *   softDeleteRetentionInDays: 7,
 * });
 * ```
 *
 * ### Access Policies
 * **Example:** Vault with inline access policies
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("legacy", {
 *   resourceGroup: group.resourceGroupName,
 *   enableRbacAuthorization: false,
 *   accessPolicies: [
 *     { objectId: identity.principalId, permissions: { secrets: ["get", "list"] } },
 *   ],
 * });
 * ```
 *
 * ### Network Rules
 * **Example:** Deny public traffic except one IP range
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("locked", {
 *   resourceGroup: group.resourceGroupName,
 *   networkAcls: { defaultAction: "Deny", ipRules: ["203.0.113.0/24"] },
 * });
 * ```
 *
 * @resource
 */
export const Vault = Resource<Vault>("Azure.KeyVault.Vault");

type ObservedVault = keyvault.GetVaultResponse;

const toAttrs = (
  resourceGroup: string,
  name: string,
  vault: ObservedVault,
  purgeOnDelete: boolean,
): Vault["Attributes"] => ({
  vaultName: name,
  vaultId: vault.id ?? "",
  vaultUri: vault.properties.vaultUri ?? `https://${name}.vault.azure.net/`,
  resourceGroup,
  location: vault.location ?? "",
  tenantId: vault.properties.tenantId,
  sku: vault.properties.sku.name,
  enableRbacAuthorization: vault.properties.enableRbacAuthorization ?? false,
  softDeleteRetentionInDays: vault.properties.softDeleteRetentionInDays ?? 90,
  enablePurgeProtection: vault.properties.enablePurgeProtection ?? false,
  purgeOnDelete,
  tags: userTags(vault.tags),
});

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].map((v) => v.toLowerCase()).sort();

const cidr = (value: string) => (value.includes("/") ? value : `${value}/32`);

const normalizeAcls = (acls: keyvault.NetworkRuleSet | undefined) =>
  JSON.stringify({
    bypass: acls?.bypass ?? "AzureServices",
    defaultAction: acls?.defaultAction ?? "Allow",
    ipRules: sorted((acls?.ipRules ?? []).map((rule) => cidr(rule.value))),
    vnet: sorted((acls?.virtualNetworkRules ?? []).map((rule) => rule.id)),
  });

const toNetworkRuleSet = (acls: VaultNetworkAcls): keyvault.NetworkRuleSet => ({
  bypass: acls.bypass ?? "AzureServices",
  defaultAction: acls.defaultAction ?? "Allow",
  ipRules: (acls.ipRules ?? []).map((value) => ({ value })),
  virtualNetworkRules: (acls.virtualNetworkRules ?? []).map((id) => ({ id })),
});

/** Access policy entries with the tenant filled in. */
export const toAccessPolicyEntries = (
  entries: readonly VaultAccessPolicyEntry[],
  tenantId: string,
): keyvault.AccessPolicyEntry[] =>
  entries.map((entry) => ({
    tenantId: entry.tenantId ?? tenantId,
    objectId: entry.objectId,
    applicationId: entry.applicationId,
    permissions: entry.permissions,
  }));

/** Order-insensitive comparison key for access policies. */
export const normalizePolicies = (
  entries: readonly keyvault.AccessPolicyEntry[] | undefined,
) =>
  JSON.stringify(
    (entries ?? [])
      .map((entry) => ({
        tenantId: entry.tenantId.toLowerCase(),
        objectId: entry.objectId.toLowerCase(),
        applicationId: entry.applicationId?.toLowerCase() ?? "",
        keys: sorted(entry.permissions.keys),
        secrets: sorted(entry.permissions.secrets),
        certificates: sorted(entry.permissions.certificates),
        storage: sorted(entry.permissions.storage),
      }))
      .sort((a, b) =>
        `${a.objectId}/${a.applicationId}`.localeCompare(
          `${b.objectId}/${b.applicationId}`,
        ),
      ),
  );

export const VaultProvider = () =>
  Provider.succeed(Vault, {
    stables: ["vaultName", "vaultId", "vaultUri", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* keyvault
        .ListVaultBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListVaultBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((vault) => {
        const group = resourceGroupOf(vault.id);
        return hasAnyAlchemyTag(vault.tags) &&
          group !== undefined &&
          vault.name !== undefined
          ? [toAttrs(group, vault.name, vault as ObservedVault, true)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.vaultName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
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
        output?.vaultName ?? olds?.name ?? (yield* createVaultName(id));
      const observed = yield* getVault(subscriptionId, resourceGroup, name);
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
        news.name ?? output?.vaultName ?? (yield* createVaultName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tenantId = news.tenantId ?? env.tenantId;
      const sku = news.sku ?? "standard";
      const rbac = news.enableRbacAuthorization ?? true;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: name,
      };
      const label = `key vault ${name}`;
      const policies =
        news.accessPolicies === undefined
          ? undefined
          : toAccessPolicyEntries(news.accessPolicies, tenantId);
      const networkAcls =
        news.networkAcls === undefined
          ? undefined
          : toNetworkRuleSet(news.networkAcls);

      // Observe.
      let observed = yield* getVault(subscriptionId, resourceGroup, name);

      // Ensure. A soft-deleted vault of ours with the same name (e.g. after
      // `purgeOnDelete: false`) holds the name; recover it instead.
      if (observed === undefined) {
        const deleted = yield* getDeletedVault(subscriptionId, location, name);
        const recover =
          deleted !== undefined &&
          (yield* isOwned(id, deleted.properties?.tags));
        yield* keyvault.VaultsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: recover
            ? {
                tenantId,
                sku: { family: "A", name: sku },
                createMode: "recover",
              }
            : {
                tenantId,
                sku: { family: "A", name: sku },
                accessPolicies: policies ?? [],
                enableRbacAuthorization: rbac,
                enabledForDeployment: news.enabledForDeployment,
                enabledForDiskEncryption: news.enabledForDiskEncryption,
                enabledForTemplateDeployment: news.enabledForTemplateDeployment,
                softDeleteRetentionInDays: news.softDeleteRetentionInDays ?? 90,
                enablePurgeProtection: news.enablePurgeProtection || undefined,
                networkAcls,
                publicNetworkAccess: news.publicNetworkAccess,
              },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        getVault(subscriptionId, resourceGroup, name),
        (vault) => vault.properties.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties;
      const changed: keyvault.VaultPatchProperties = {};
      if (lower(props.sku.name) !== sku)
        changed.sku = { family: "A", name: sku };
      if (lower(props.tenantId) !== lower(tenantId))
        changed.tenantId = tenantId;
      if ((props.enableRbacAuthorization ?? false) !== rbac) {
        changed.enableRbacAuthorization = rbac;
      }
      for (const key of [
        "enabledForDeployment",
        "enabledForDiskEncryption",
        "enabledForTemplateDeployment",
      ] as const) {
        const value = news[key];
        if (value !== undefined && (props[key] ?? false) !== value) {
          changed[key] = value;
        }
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
        lower(props.publicNetworkAccess ?? "Enabled") !==
          lower(news.publicNetworkAccess)
      ) {
        changed.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (
        policies !== undefined &&
        normalizePolicies(props.accessPolicies) !== normalizePolicies(policies)
      ) {
        changed.accessPolicies = policies;
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || tagsChanged) {
        yield* keyvault.UpdateVault({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          getVault(subscriptionId, resourceGroup, name),
          (vault) => vault.properties.provisioningState,
          { interval: "3 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed, news.purgeOnDelete ?? true);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.vaultName;
      yield* ignoreNotFound(
        keyvault.DeleteVault({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vaultName: name,
        }),
      );
      yield* waitUntilGone(
        `key vault ${name}`,
        getVault(subscriptionId, output.resourceGroup, name),
      );
      if (output.purgeOnDelete === false || output.enablePurgeProtection) {
        return;
      }
      // Purge frees the globally unique name; it runs asynchronously.
      yield* ignoreNotFound(
        keyvault.PurgeVaultDeleted({
          subscriptionId,
          location: output.location,
          vaultName: name,
        }),
      );
      yield* waitUntilGone(
        `deleted key vault ${name}`,
        getDeletedVault(subscriptionId, output.location, name),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
