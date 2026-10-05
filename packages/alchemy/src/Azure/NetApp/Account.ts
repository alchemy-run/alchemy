import * as netapp from "@distilled.cloud/azure/netapp";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNetAppName,
  getAccount,
  listAllAccounts,
  LRO_BUDGET,
  matchesObserved,
  parseNetAppId,
  sameText,
  whileBusy,
} from "./Common.ts";

/** Active Directory connection used by SMB and dual-protocol volumes. */
export interface NetAppActiveDirectory {
  /** Name of an Active Directory machine-account admin. */
  username: string;
  /** Password of the admin account. Never read back from Azure. */
  password: Redacted.Redacted<string>;
  /** Fully qualified Active Directory DNS domain, e.g. `contoso.com`. */
  domain: string;
  /** Comma-separated DNS server IP addresses for the domain. */
  dns: string;
  /** NetBIOS name prefix of the SMB server (up to 10 characters). */
  smbServerName: string;
  /** Organizational unit for the SMB server machine account. @default "CN=Computers" */
  organizationalUnit?: string;
  /** Active Directory site the domain controllers belong to. */
  site?: string;
  /** Users added to the built-in Backup Operators group. */
  backupOperators?: string[];
  /** Users added to the built-in Administrators group. */
  administrators?: string[];
  /** Users with SeSecurityPrivilege (SQL Server on SMB). */
  securityOperators?: string[];
  /** IP of the Kerberos KDC (Kerberos volumes). */
  kdcIP?: string;
  /** Name of the Active Directory machine account for Kerberos. */
  adName?: string;
  /** Base64 PEM root CA certificate for LDAP over TLS. */
  serverRootCACertificate?: string;
  /** Use AES encryption for SMB communication. */
  aesEncryption?: boolean;
  /** Require LDAP signing. */
  ldapSigning?: boolean;
  /** Use LDAP over TLS. */
  ldapOverTLS?: boolean;
  /** Let local NFS users bypass LDAP. */
  allowLocalNfsUsersWithLdap?: boolean;
  /** Encrypt traffic to domain controllers. */
  encryptDCConnections?: boolean;
  /** Comma-separated preferred LDAP server IPs. */
  preferredServersForLdapClient?: string;
}

/** Customer-managed key encryption of the account's volumes. */
export interface NetAppAccountEncryption {
  /**
   * Key source. Moving from `Microsoft.NetApp` to `Microsoft.KeyVault`
   * happens in place; Azure cannot move back.
   */
  keySource: "Microsoft.NetApp" | "Microsoft.KeyVault";
  /** Key Vault key (required for `Microsoft.KeyVault`). */
  keyVaultProperties?: {
    /** URI of the Key Vault, e.g. `https://myvault.vault.azure.net`. */
    keyVaultUri: string;
    /** Name of the key. */
    keyName: string;
    /** ARM resource ID of the Key Vault. */
    keyVaultResourceId?: string;
  };
  /**
   * ARM ID of the user-assigned identity used to reach the vault (must be
   * listed in `identity.userAssignedIdentities`).
   */
  userAssignedIdentity?: string;
  /** Client ID of a multi-tenant Entra application for cross-tenant vaults. */
  federatedClientId?: string;
}

export interface AccountProps {
  /** Resource group the account is created in. Changing it replaces the account. */
  resourceGroup: string;
  /**
   * Account name: 1-128 letters, digits, `-` and `_`, starting with a
   * letter or digit. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account. Pools, volumes, and policies live in the
   * same location. Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Active Directory connection for SMB / dual-protocol volumes. Azure
   * allows one connection per subscription and region.
   */
  activeDirectories?: NetAppActiveDirectory[];
  /** Encryption key source of the account's volumes. */
  encryption?: NetAppAccountEncryption;
  /**
   * Domain for NFSv4 user ID mapping. Applies to every account in the
   * subscription and region.
   */
  nfsV4IDDomain?: string;
  /** Managed identity of the account (needed for customer-managed keys). */
  identity?: {
    /** Identity type. */
    type:
      | "None"
      | "SystemAssigned"
      | "UserAssigned"
      | "SystemAssigned,UserAssigned";
    /** ARM IDs of user-assigned identities. */
    userAssignedIdentities?: string[];
  };
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "Azure.NetApp.Account",
  AccountProps,
  {
    /** Name of the NetApp account. */
    accountName: string;
    /** ARM resource ID of the account. */
    accountId: string;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** Location of the account. */
    location: string;
    /** Encryption key source (`Microsoft.NetApp` or `Microsoft.KeyVault`). */
    keySource: string | undefined;
    /** NFSv4 ID mapping domain. */
    nfsV4IDDomain: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Whether showmount is disabled for the account's NFS volumes. */
    disableShowmount: boolean | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure NetApp Files account — the management container for capacity
 * pools, volumes, snapshot and backup policies, and backup vaults. The
 * account itself is free; capacity pools are billed.
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/azure-netapp-files-create-netapp-account
 *
 * ### Creating an Account
 * **Example:** NetApp account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("storage");
 * const account = yield* Azure.NetApp.Account("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### NFSv4 Identity Mapping
 * **Example:** Set the NFSv4 ID domain
 * ```typescript
 * const account = yield* Azure.NetApp.Account("files", {
 *   resourceGroup: group.resourceGroupName,
 *   nfsV4IDDomain: "contoso.com",
 * });
 * ```
 *
 * ### SMB Volumes
 * **Example:** Join an Active Directory domain
 * ```typescript
 * const account = yield* Azure.NetApp.Account("files", {
 *   resourceGroup: group.resourceGroupName,
 *   activeDirectories: [
 *     {
 *       username: "anfadmin",
 *       password: Redacted.make(process.env.AD_PASSWORD!),
 *       domain: "contoso.com",
 *       dns: "10.0.0.4",
 *       smbServerName: "anfsmb",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Account = Resource<Account>("Azure.NetApp.Account");

type ObservedAccount = netapp.GetAccountResponse | netapp.NetAppAccount;

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: ObservedAccount,
): Account["Attributes"] => ({
  accountName: name,
  accountId: account.id ?? "",
  resourceGroup,
  location: account.location ?? "",
  keySource: account.properties?.encryption?.keySource,
  nfsV4IDDomain: account.properties?.nfsV4IDDomain ?? undefined,
  principalId: account.identity?.principalId,
  disableShowmount: account.properties?.disableShowmount ?? undefined,
  tags: userTags(account.tags),
});

const toEncryption = (
  encryption: NetAppAccountEncryption | undefined,
): netapp.AccountEncryptionInput | undefined =>
  encryption === undefined
    ? undefined
    : {
        keySource: encryption.keySource,
        keyVaultProperties: encryption.keyVaultProperties,
        identity:
          encryption.userAssignedIdentity || encryption.federatedClientId
            ? {
                userAssignedIdentity: encryption.userAssignedIdentity,
                federatedClientId: encryption.federatedClientId,
              }
            : undefined,
      };

const toIdentity = (identity: AccountProps["identity"]) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentities
          ? Object.fromEntries(
              identity.userAssignedIdentities.map((id) => [id, {}]),
            )
          : undefined,
      };

/** Active Directory fields that Azure reads back (everything but the password). */
const visibleDirectory = ({ password: _, ...rest }: NetAppActiveDirectory) =>
  rest;

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: ["accountName", "accountId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const accounts = yield* listAllAccounts(subscriptionId);
      return accounts.flatMap((account) => {
        const { resourceGroup } = parseNetAppId(account.id);
        return hasAnyAlchemyTag(account.tags) &&
          resourceGroup !== undefined &&
          account.name !== undefined
          ? [toAttrs(resourceGroup, account.name, account)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.accountName.toLowerCase()) ||
        (news.location !== undefined &&
          !sameText(news.location, output.location)) ||
        // Customer-managed keys cannot be turned back into platform keys.
        (output.keySource === "Microsoft.KeyVault" &&
          news.encryption?.keySource !== "Microsoft.KeyVault")
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
        output?.accountName ?? olds?.name ?? (yield* createNetAppName(id, 64));
      const observed = yield* getAccount(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.accountName ?? (yield* createNetAppName(id, 64));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const get = getAccount(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `netapp account ${name}`,
        get,
        (account) => account.properties?.provisioningState,
        LRO_BUDGET,
      );
      const encryption = toEncryption(news.encryption);
      const identity = toIdentity(news.identity);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* whileBusy(
          netapp.AccountsCreateOrUpdate({
            ...where,
            location,
            tags,
            identity,
            properties: {
              activeDirectories: news.activeDirectories,
              encryption,
              nfsV4IDDomain: news.nfsV4IDDomain,
            },
          }),
        );
      }
      observed = yield* waitReady;

      // Sync properties and tags against observed state; PATCH deltas.
      const props = observed.properties ?? {};
      const changed: netapp.AccountPropertiesInput = {};
      if (
        news.nfsV4IDDomain !== undefined &&
        props.nfsV4IDDomain !== news.nfsV4IDDomain
      ) {
        changed.nfsV4IDDomain = news.nfsV4IDDomain;
      }
      if (
        encryption !== undefined &&
        !matchesObserved(encryption, props.encryption)
      ) {
        changed.encryption = encryption;
      }
      if (news.activeDirectories !== undefined) {
        const observedDirectories = props.activeDirectories ?? [];
        if (
          !matchesObserved(
            news.activeDirectories.map(visibleDirectory),
            observedDirectories,
          )
        ) {
          // Keep Azure's directory IDs so the connection is updated in place.
          changed.activeDirectories = news.activeDirectories.map(
            (directory, i) => ({
              ...directory,
              activeDirectoryId: observedDirectories[i]?.activeDirectoryId,
            }),
          );
        }
      }
      const identityChanged =
        identity !== undefined &&
        (observed.identity?.type !== identity.type ||
          !matchesObserved(
            Object.keys(identity.userAssignedIdentities ?? {}).sort(),
            Object.keys(observed.identity?.userAssignedIdentities ?? {}).sort(),
          ));
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || identityChanged || tagsChanged) {
        yield* whileBusy(
          netapp.UpdateAccount({
            ...where,
            tags: tagsChanged ? tags : undefined,
            identity: identityChanged ? identity : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          }),
        );
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Pools, policies, and vaults drain asynchronously; the account delete
      // is rejected until they are gone.
      yield* whileBusy(
        ignoreNotFound(
          netapp.DeleteAccount({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.accountName,
          }),
        ),
      );
      yield* waitUntilGone(
        `netapp account ${output.accountName}`,
        getAccount(subscriptionId, output.resourceGroup, output.accountName),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
