import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

/** Access a local user has to one container or file share. */
export interface LocalUserPermissionScope {
  /**
   * Abbreviated permissions: `r` (read), `w` (write), `d` (delete),
   * `l` (list), `c` (create), `m` (modify ownership), `o` (owner),
   * `e` (execute), `p` (permissions), e.g. `"rwl"`.
   */
  permissions: string;
  /** Service the scope applies to: `blob` or `file`. */
  service: "blob" | "file";
  /** Name of the container or file share. */
  resourceName: string;
}

/** An SSH public key authorized for the local user. */
export interface LocalUserSshKey {
  /** Description of the key. */
  description?: string;
  /** Public key in OpenSSH format, e.g. `ssh-ed25519 AAAA...`. */
  key: string;
}

export interface LocalUserProps {
  /**
   * Resource group of the storage account. Changing it replaces the user.
   */
  resourceGroup: string;
  /** Storage account the user belongs to. Changing it replaces the user. */
  storageAccount: string;
  /**
   * Username: 3-64 lowercase letters and digits. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the user.
   */
  name?: string;
  /** Containers and file shares the user can access. */
  permissionScopes?: LocalUserPermissionScope[];
  /**
   * Home directory, e.g. `"container/dir"`.
   * @default the container root
   */
  homeDirectory?: string;
  /**
   * SSH public keys authorized for SFTP. Setting keys implies
   * `hasSshKey: true`.
   * @default []
   */
  sshAuthorizedKeys?: LocalUserSshKey[];
  /**
   * Whether the user may authenticate with a shared key.
   * @default false
   */
  hasSharedKey?: boolean;
  /**
   * Whether the user may authenticate with SSH keys.
   * @default true when `sshAuthorizedKeys` is non-empty
   */
  hasSshKey?: boolean;
  /**
   * Whether the user may authenticate with an SSH password (generate one
   * with the `regeneratePassword` action).
   * @default false
   */
  hasSshPassword?: boolean;
  /** POSIX group ID for authorization on hierarchical-namespace accounts. */
  groupId?: number;
  /**
   * Whether ACL authorization applies to the user (hierarchical-namespace
   * accounts).
   * @default false
   */
  allowAclAuthorization?: boolean;
  /** Supplementary POSIX group IDs. */
  extendedGroups?: number[];
}

export interface LocalUser extends Resource<
  "Azure.Storage.LocalUser",
  LocalUserProps,
  {
    /** Username of the local user. */
    localUserName: string;
    /** ARM resource ID of the local user. */
    localUserId: string;
    /** Storage account the user belongs to. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** Security identifier Azure generated for the user. */
    sid: string | undefined;
    /** POSIX user ID Azure assigned to the user. */
    userId: number | undefined;
    /** Observed permission scopes. */
    permissionScopes: LocalUserPermissionScope[];
    /** Observed home directory. */
    homeDirectory: string | undefined;
    /** Whether shared-key authentication is enabled. */
    hasSharedKey: boolean;
    /** Whether SSH key authentication is enabled. */
    hasSshKey: boolean;
    /** Whether SSH password authentication is enabled. */
    hasSshPassword: boolean;
  },
  never,
  Providers
> {}

/**
 * A local user of a Storage account, used to sign in over SFTP (and SMB
 * local-user access) with a password or SSH key instead of Microsoft Entra
 * ID.
 *
 * Local users require `isLocalUserEnabled` on the account (enabled by
 * default); SFTP sign-in additionally requires a hierarchical-namespace
 * account with SFTP enabled. Local users carry no tags, so ownership
 * follows the storage account.
 *
 * @see https://learn.microsoft.com/azure/storage/blobs/secure-file-transfer-protocol-support-how-to
 *
 * ### SFTP Users
 * **Example:** Read/write user scoped to one container
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("sftp", {
 *   resourceGroup: group.resourceGroupName,
 *   isHnsEnabled: true,
 * });
 * const uploads = yield* Azure.Storage.BlobContainer("uploads", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * yield* Azure.Storage.LocalUser("partner", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   name: "partner",
 *   homeDirectory: "uploads",
 *   permissionScopes: [
 *     { service: "blob", resourceName: uploads.containerName, permissions: "rwl" },
 *   ],
 *   sshAuthorizedKeys: [{ key: "ssh-ed25519 AAAAC3Nza... partner@example.com" }],
 * });
 * ```
 *
 * **Example:** Read-only password user
 * ```typescript
 * yield* Azure.Storage.LocalUser("auditor", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   hasSshPassword: true,
 *   permissionScopes: [
 *     { service: "blob", resourceName: "reports", permissions: "rl" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const LocalUser = Resource<LocalUser>("Azure.Storage.LocalUser");

type Observed = storage.GetLocalUserResponse;

/** Usernames: 3-64 lowercase letters and digits. */
const createLocalUserName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 64,
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "").slice(0, 64);
});

const getUser = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  username: string,
) =>
  orUndefinedIfNotFound(
    storage.GetLocalUser({
      subscriptionId,
      resourceGroupName,
      accountName,
      username,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  name: string,
  user: Observed,
): LocalUser["Attributes"] => {
  const p = user.properties;
  return {
    localUserName: name,
    localUserId: user.id ?? "",
    storageAccount,
    resourceGroup,
    sid: p?.sid,
    userId: p?.userId,
    permissionScopes: (p?.permissionScopes ?? []).map((scope) => ({
      permissions: scope.permissions,
      service: scope.service as LocalUserPermissionScope["service"],
      resourceName: scope.resourceName,
    })),
    homeDirectory: p?.homeDirectory || undefined,
    hasSharedKey: p?.hasSharedKey ?? false,
    hasSshKey: p?.hasSshKey ?? false,
    hasSshPassword: p?.hasSshPassword ?? false,
  };
};

const desiredProperties = (
  news: LocalUserProps,
): storage.LocalUserPropertiesInput => ({
  permissionScopes: news.permissionScopes ?? [],
  homeDirectory: news.homeDirectory,
  sshAuthorizedKeys: news.sshAuthorizedKeys ?? [],
  hasSharedKey: news.hasSharedKey ?? false,
  hasSshKey: news.hasSshKey ?? (news.sshAuthorizedKeys ?? []).length > 0,
  hasSshPassword: news.hasSshPassword ?? false,
  groupId: news.groupId,
  allowAclAuthorization: news.allowAclAuthorization,
  extendedGroups: news.extendedGroups,
});

/** Permission strings compare as character sets. */
const scopeKey = (scopes: ReadonlyArray<storage.PermissionScope>) =>
  JSON.stringify(
    scopes
      .map((scope) => ({
        service: scope.service.toLowerCase(),
        resourceName: scope.resourceName,
        permissions: [...scope.permissions].sort().join(""),
      }))
      .sort((a, b) =>
        `${a.service}/${a.resourceName}`.localeCompare(
          `${b.service}/${b.resourceName}`,
        ),
      ),
  );

const keysKey = (keys: ReadonlyArray<storage.SshPublicKey>) =>
  JSON.stringify(
    keys
      .map((key) => ({
        key: (key.key ?? "").trim(),
        description: key.description ?? "",
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );

const sameNumbers = (
  observed: ReadonlyArray<number> | undefined,
  desired: ReadonlyArray<number> | undefined,
) =>
  desired === undefined ||
  JSON.stringify([...(observed ?? [])].sort()) ===
    JSON.stringify([...desired].sort());

/** Whether the observed user differs from the desired properties. */
const differs = (
  observed: Observed,
  observedKeys: ReadonlyArray<storage.SshPublicKey>,
  desired: storage.LocalUserPropertiesInput,
) => {
  const p = observed.properties ?? {};
  return (
    scopeKey(p.permissionScopes ?? []) !==
      scopeKey(desired.permissionScopes ?? []) ||
    (desired.homeDirectory !== undefined &&
      (p.homeDirectory ?? "") !== desired.homeDirectory) ||
    keysKey(observedKeys) !== keysKey(desired.sshAuthorizedKeys ?? []) ||
    (p.hasSharedKey ?? false) !== desired.hasSharedKey ||
    (p.hasSshKey ?? false) !== desired.hasSshKey ||
    (p.hasSshPassword ?? false) !== desired.hasSshPassword ||
    (desired.groupId !== undefined && p.groupId !== desired.groupId) ||
    (desired.allowAclAuthorization !== undefined &&
      (p.allowAclAuthorization ?? false) !== desired.allowAclAuthorization) ||
    !sameNumbers(p.extendedGroups, desired.extendedGroups)
  );
};

export const LocalUserProvider = () =>
  Provider.succeed(LocalUser, {
    stables: [
      "localUserName",
      "localUserId",
      "storageAccount",
      "resourceGroup",
    ],

    // Local users disappear with their storage account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ id, news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const name = news.name ?? (yield* createLocalUserName(id));
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        name !== output.localUserName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const name =
        output?.localUserName ?? olds?.name ?? (yield* createLocalUserName(id));
      const observed = yield* getUser(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        storageAccount,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name =
        news.name ?? output?.localUserName ?? (yield* createLocalUserName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
        username: name,
      };
      const get = getUser(subscriptionId, resourceGroup, storageAccount, name);
      const desired = desiredProperties(news);

      // Observe. SSH keys are only returned by the listKeys action.
      const observed = yield* get;
      const observedKeys =
        observed === undefined
          ? []
          : ((yield* storage.ListLocalUserKeys(where)).sshAuthorizedKeys ?? []);

      // Ensure + sync: the PUT is a full upsert of the user's properties.
      if (observed === undefined || differs(observed, observedKeys, desired)) {
        yield* storage.LocalUsersCreateOrUpdate({
          ...where,
          properties: desired,
        });
      }
      const fresh = yield* waitForProvisioned(
        `local user ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, storageAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteLocalUser({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          username: output.localUserName,
        }),
      );
      yield* waitUntilGone(
        `local user ${output.localUserName}`,
        getUser(
          subscriptionId,
          output.resourceGroup,
          output.storageAccount,
          output.localUserName,
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
