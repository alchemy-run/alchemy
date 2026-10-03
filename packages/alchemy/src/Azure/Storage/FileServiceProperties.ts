import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fromStorageCorsRules,
  storageCorsDiffers,
  toStorageCorsRules,
  type StorageCorsRule,
} from "./StorageCors.ts";
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

/** File share soft-delete settings. */
export interface ShareDeleteRetentionPolicy {
  /** Whether deleted shares are retained. */
  enabled: boolean;
  /** Days deleted shares are retained (1-365). Required when enabled. */
  days?: number;
}

/**
 * SMB protocol settings. Each list is a `;`-separated string, e.g.
 * `"SMB3.0;SMB3.1.1"`.
 */
export interface SmbSettings {
  /**
   * Allowed SMB versions: `SMB2.1`, `SMB3.0`, `SMB3.1.1`.
   * @default "SMB2.1;SMB3.0;SMB3.1.1"
   */
  versions?: string;
  /**
   * Allowed authentication methods: `NTLMv2`, `Kerberos`.
   * @default "NTLMv2;Kerberos"
   */
  authenticationMethods?: string;
  /**
   * Allowed Kerberos ticket encryption: `RC4-HMAC`, `AES-256`.
   * @default "RC4-HMAC;AES-256"
   */
  kerberosTicketEncryption?: string;
  /**
   * Allowed channel encryption: `AES-128-CCM`, `AES-128-GCM`, `AES-256-GCM`.
   * @default "AES-128-CCM;AES-128-GCM;AES-256-GCM"
   */
  channelEncryption?: string;
  /**
   * SMB Multichannel. Only supported on premium (`FileStorage`) accounts.
   * @default unmanaged
   */
  multichannelEnabled?: boolean;
}

export interface FileServicePropertiesProps {
  /**
   * Resource group of the storage account. Changing it replaces the
   * settings resource.
   */
  resourceGroup: string;
  /**
   * Storage account whose File service is configured. Changing it replaces
   * the settings resource.
   */
  storageAccount: string;
  /**
   * CORS rules (at most 5). An empty list removes every rule.
   * @default unmanaged
   */
  cors?: StorageCorsRule[];
  /**
   * File share soft delete.
   * @default unmanaged
   */
  shareDeleteRetentionPolicy?: ShareDeleteRetentionPolicy;
  /**
   * SMB protocol settings. Only the fields you set are managed.
   * @default unmanaged
   */
  smb?: SmbSettings;
}

export interface FileServiceProperties extends Resource<
  "Azure.Storage.FileServiceProperties",
  FileServicePropertiesProps,
  {
    /** Storage account whose File service is configured. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the File service (`.../fileServices/default`). */
    fileServiceId: string;
    /** Observed CORS rules. */
    cors: StorageCorsRule[];
    /** Observed share soft-delete policy. */
    shareDeleteRetentionPolicy: ShareDeleteRetentionPolicy;
    /** Observed SMB settings (unset fields are Azure's defaults). */
    smb: SmbSettings;
  },
  never,
  Providers
> {}

/**
 * The File service settings of a Storage account
 * (`fileServices/default`): CORS, share soft delete, and SMB protocol
 * settings.
 *
 * This is a singleton: every account has exactly one File service. Only the
 * settings you specify are managed. Destroying the resource restores
 * Azure's defaults for those settings (CORS removed, 7-day share soft
 * delete, every SMB version/method allowed).
 *
 * @see https://learn.microsoft.com/azure/storage/files/storage-files-enable-soft-delete
 *
 * ### Data Protection
 * **Example:** Keep deleted shares for 14 days
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Storage.FileServiceProperties("files-settings", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   shareDeleteRetentionPolicy: { enabled: true, days: 14 },
 * });
 * ```
 *
 * ### SMB Hardening
 * **Example:** Require SMB 3.1.1 with Kerberos and AES-256
 * ```typescript
 * yield* Azure.Storage.FileServiceProperties("files-settings", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   smb: {
 *     versions: "SMB3.1.1",
 *     authenticationMethods: "Kerberos",
 *     kerberosTicketEncryption: "AES-256",
 *     channelEncryption: "AES-256-GCM",
 *   },
 * });
 * ```
 *
 * ### CORS
 * **Example:** Allow browser downloads from one origin
 * ```typescript
 * yield* Azure.Storage.FileServiceProperties("files-settings", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   cors: [
 *     { allowedOrigins: ["https://app.example.com"], allowedMethods: ["GET"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const FileServiceProperties = Resource<FileServiceProperties>(
  "Azure.Storage.FileServiceProperties",
);

type Observed = storage.GetFileServiceServicePropertiesResponse;

/** Azure's SMB defaults (every version, method, and cipher allowed). */
const SMB_DEFAULTS = {
  versions: "SMB2.1;SMB3.0;SMB3.1.1",
  authenticationMethods: "NTLMv2;Kerberos",
  kerberosTicketEncryption: "RC4-HMAC;AES-256",
  channelEncryption: "AES-128-CCM;AES-128-GCM;AES-256-GCM",
} as const;

const SMB_LIST_KEYS = [
  "versions",
  "authenticationMethods",
  "kerberosTicketEncryption",
  "channelEncryption",
] as const;

/** `;`-separated lists compare as sets; empty means Azure's default. */
const sameList = (
  observed: string | undefined,
  desired: string,
  fallback: string,
) => {
  const norm = (value: string) =>
    value
      .split(";")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .sort()
      .join(";");
  return norm(observed || fallback) === norm(desired);
};

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetFileServiceServiceProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  observed: Observed,
): FileServiceProperties["Attributes"] => {
  const props = observed.properties ?? {};
  const smb = props.protocolSettings?.smb;
  return {
    storageAccount,
    resourceGroup,
    fileServiceId: observed.id ?? "",
    cors: fromStorageCorsRules(props.cors),
    shareDeleteRetentionPolicy: {
      enabled: props.shareDeleteRetentionPolicy?.enabled ?? false,
      days: props.shareDeleteRetentionPolicy?.enabled
        ? props.shareDeleteRetentionPolicy.days
        : undefined,
    },
    smb: {
      versions: smb?.versions || undefined,
      authenticationMethods: smb?.authenticationMethods || undefined,
      kerberosTicketEncryption: smb?.kerberosTicketEncryption || undefined,
      channelEncryption: smb?.channelEncryption || undefined,
      multichannelEnabled: smb?.multichannel?.enabled,
    },
  };
};

/** The delta between observed and desired settings. */
const delta = (
  observed: FileServiceProperties["Attributes"],
  news: FileServicePropertiesProps,
): storage.FileServicePropertiesProperties => {
  const changed: storage.FileServicePropertiesProperties = {};
  if (news.cors !== undefined && storageCorsDiffers(observed.cors, news.cors)) {
    changed.cors = { corsRules: toStorageCorsRules(news.cors) };
  }
  const retention = news.shareDeleteRetentionPolicy;
  if (
    retention !== undefined &&
    (observed.shareDeleteRetentionPolicy.enabled !== retention.enabled ||
      (retention.enabled &&
        observed.shareDeleteRetentionPolicy.days !== retention.days))
  ) {
    changed.shareDeleteRetentionPolicy = retention;
  }
  if (news.smb !== undefined) {
    const smb: storage.SmbSetting = {};
    for (const key of SMB_LIST_KEYS) {
      const desired = news.smb[key];
      if (
        desired !== undefined &&
        !sameList(observed.smb[key], desired, SMB_DEFAULTS[key])
      ) {
        smb[key] = desired;
      }
    }
    if (
      news.smb.multichannelEnabled !== undefined &&
      (observed.smb.multichannelEnabled ?? false) !==
        news.smb.multichannelEnabled
    ) {
      smb.multichannel = { enabled: news.smb.multichannelEnabled };
    }
    if (Object.keys(smb).length > 0) changed.protocolSettings = { smb };
  }
  return changed;
};

/** Azure's defaults for every aspect the user configured. */
const defaultsFor = (
  olds: Partial<FileServicePropertiesProps>,
): storage.FileServicePropertiesProperties => {
  const reset: storage.FileServicePropertiesProperties = {};
  if (olds.cors !== undefined) reset.cors = { corsRules: [] };
  if (olds.shareDeleteRetentionPolicy !== undefined) {
    reset.shareDeleteRetentionPolicy = { enabled: true, days: 7 };
  }
  if (olds.smb !== undefined) {
    const smb: storage.SmbSetting = {};
    for (const key of SMB_LIST_KEYS) {
      if (olds.smb[key] !== undefined) smb[key] = SMB_DEFAULTS[key];
    }
    if (olds.smb.multichannelEnabled !== undefined) {
      smb.multichannel = { enabled: false };
    }
    if (Object.keys(smb).length > 0) reset.protocolSettings = { smb };
  }
  return reset;
};

export const FileServicePropertiesProvider = () =>
  Provider.succeed(FileServiceProperties, {
    stables: ["storageAccount", "resourceGroup", "fileServiceId"],

    // A per-account singleton that disappears with its account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const observed = yield* getService(
        subscriptionId,
        resourceGroup,
        storageAccount,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        storageAccount,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
      };

      // Observe. The File service always exists alongside its account.
      const observed = yield* storage.GetFileServiceServiceProperties(where);

      // Sync only the aspects that differ; omitted properties are kept.
      const changed = delta(
        toAttrs(resourceGroup, storageAccount, observed),
        news,
      );
      if (Object.keys(changed).length === 0) {
        return toAttrs(resourceGroup, storageAccount, observed);
      }
      yield* storage.SetFileServiceServiceProperties({
        ...where,
        properties: changed,
      });
      const fresh = yield* storage.GetFileServiceServiceProperties(where);
      return toAttrs(resourceGroup, storageAccount, fresh);
    }),

    // Restore Azure's defaults for the managed settings; a missing account
    // means there is nothing left to reset.
    delete: Effect.fn(function* ({ olds, output }) {
      const reset = defaultsFor(olds ?? {});
      if (Object.keys(reset).length === 0) return;
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.SetFileServiceServiceProperties({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          properties: reset,
        }),
      );
    }),

    nuke: { singleton: true },
  });
