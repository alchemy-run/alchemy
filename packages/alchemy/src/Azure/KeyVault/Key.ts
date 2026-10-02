import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  isOwned,
  orUndefinedIfNotFound,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createObjectName, lower } from "./common.ts";

export type KeyType = keyvault.JsonWebKeyType;
export type KeyOperation = keyvault.JsonWebKeyOperation;
export type KeyCurveName = keyvault.JsonWebKeyCurveName;

/** Automatic rotation policy of a key. */
export interface KeyRotationPolicy {
  /** Lifetime of new key versions as an ISO 8601 duration, e.g. `P90D`. */
  expiryTime?: string;
  /** Rotation or notification actions. */
  lifetimeActions?: {
    /** `rotate` creates a new version; `notify` emits an Event Grid event. */
    action: "rotate" | "notify";
    /** Duration after creation, e.g. `P60D` (rotate only). */
    timeAfterCreate?: string;
    /** Duration before expiry, e.g. `P30D`. */
    timeBeforeExpiry?: string;
  }[];
}

/**
 * Key properties shared by vault keys and managed HSM keys. Azure Resource
 * Manager cannot change an existing key, so every property is fixed at
 * creation and changing any of them replaces the key.
 */
export interface KeyCommonProps {
  /**
   * Key name: 1-127 letters, digits, and hyphens. If omitted, a unique name
   * is generated from the app, stage, and logical ID.
   */
  name?: string;
  /**
   * Key type. `-HSM` types need a premium vault (or a managed HSM).
   * @default "RSA"
   */
  kty?: KeyType;
  /**
   * RSA key size in bits (2048, 3072, or 4096).
   * @default 2048 for RSA keys
   */
  keySize?: number;
  /**
   * Elliptic curve for EC keys.
   * @default "P-256" for EC keys
   */
  curveName?: KeyCurveName;
  /**
   * Permitted operations.
   * @default all operations valid for the key type
   */
  keyOps?: KeyOperation[];
  /**
   * Whether the key is enabled.
   * @default true
   */
  enabled?: boolean;
  /** Not-before time (Unix seconds). */
  notBefore?: number;
  /** Expiry time (Unix seconds). */
  expires?: number;
  /** Automatic rotation policy. */
  rotationPolicy?: KeyRotationPolicy;
  /**
   * User tags. Alchemy ownership tags are merged in automatically. Tags are
   * written only when the key is created.
   */
  tags?: Record<string, string>;
}

export interface KeyProps extends KeyCommonProps {
  /** Resource group of the vault. Changing it replaces the key. */
  resourceGroup: string;
  /** Vault that holds the key. Changing it replaces the key. */
  vault: string;
}

export interface KeyAttrs {
  /** Name of the key. */
  keyName: string;
  /** ARM resource ID of the key; use it as a role-assignment scope. */
  keyId: string;
  /** Resource group of the parent. */
  resourceGroup: string;
  /** Data-plane URI of the latest version (use it for customer-managed keys). */
  keyUri: string;
  /** Data-plane URI of the current version. */
  keyUriWithVersion: string;
  /** Key type. */
  kty: string;
  /** RSA key size in bits. */
  keySize: number | undefined;
  /** Elliptic curve name. */
  curveName: string | undefined;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
}

export interface Key extends Resource<
  "Azure.KeyVault.Key",
  KeyProps,
  KeyAttrs & {
    /** Vault that holds the key. */
    vault: string;
  },
  never,
  Providers
> {}

/**
 * A cryptographic key in an Azure Key Vault, managed through Azure Resource
 * Manager.
 *
 * ARM creates keys but cannot change or delete them: every property change
 * creates a new key (the old one stays in the vault), and keys are removed
 * together with their vault.
 * Rotate key material with `rotationPolicy` instead of replacing the key.
 *
 * @see https://learn.microsoft.com/azure/key-vault/keys/about-keys
 *
 * ### Creating a Key
 * **Example:** RSA key for customer-managed encryption
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("keys", {
 *   resourceGroup: group.resourceGroupName,
 *   enablePurgeProtection: true,
 * });
 * const key = yield* Azure.KeyVault.Key("cmk", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   kty: "RSA",
 *   keySize: 3072,
 * });
 * ```
 *
 * **Example:** Elliptic-curve signing key
 * ```typescript
 * const signing = yield* Azure.KeyVault.Key("signing", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   kty: "EC",
 *   curveName: "P-384",
 *   keyOps: ["sign", "verify"],
 * });
 * ```
 *
 * ### Rotation
 * **Example:** Rotate every 90 days
 * ```typescript
 * const key = yield* Azure.KeyVault.Key("cmk", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   rotationPolicy: {
 *     expiryTime: "P1Y",
 *     lifetimeActions: [{ action: "rotate", timeAfterCreate: "P90D" }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Key = Resource<Key>("Azure.KeyVault.Key");

/** Request body for a create-if-not-exist key PUT. */
export const toKeyProperties = (
  props: KeyCommonProps,
): keyvault.KeyPropertiesInput => {
  const kty = props.kty ?? "RSA";
  return {
    kty,
    keySize: props.keySize ?? (kty.startsWith("RSA") ? 2048 : undefined),
    curveName: props.curveName,
    keyOps: props.keyOps,
    attributes: {
      enabled: props.enabled ?? true,
      nbf: props.notBefore,
      exp: props.expires,
    },
    rotationPolicy:
      props.rotationPolicy === undefined
        ? undefined
        : {
            attributes:
              props.rotationPolicy.expiryTime === undefined
                ? undefined
                : { expiryTime: props.rotationPolicy.expiryTime },
            lifetimeActions: props.rotationPolicy.lifetimeActions?.map(
              (entry) => ({
                action: { type: entry.action },
                trigger: {
                  timeAfterCreate: entry.timeAfterCreate,
                  timeBeforeExpiry: entry.timeBeforeExpiry,
                },
              }),
            ),
          },
  };
};

/** Fingerprint of every create-time key property (all replace the key). */
export const keySpec = (props: KeyCommonProps) =>
  JSON.stringify({
    ...toKeyProperties(props),
    keyOps: [...(props.keyOps ?? [])].sort(),
    tags: props.tags ?? {},
  });

export const toKeyAttrs = (
  resourceGroup: string,
  name: string,
  key: {
    id?: string;
    properties: keyvault.KeyProperties;
    tags?: Record<string, string | undefined>;
  },
): KeyAttrs => ({
  keyName: name,
  keyId: key.id ?? "",
  resourceGroup,
  keyUri: key.properties.keyUri ?? "",
  keyUriWithVersion: key.properties.keyUriWithVersion ?? "",
  kty: key.properties.kty ?? "",
  keySize: key.properties.keySize,
  curveName: key.properties.curveName,
  tags: userTags(key.tags),
});

const getKey = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  keyName: string,
) =>
  orUndefinedIfNotFound(
    keyvault.GetKey({ subscriptionId, resourceGroupName, vaultName, keyName }),
  );

export const KeyProvider = () =>
  Provider.succeed(Key, {
    stables: ["keyName", "keyId", "vault", "resourceGroup", "keyUri"],

    // Keys vanish with their vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.vault) !== lower(output.vault) ||
        (news.name !== undefined && news.name !== output.keyName) ||
        (olds !== undefined && keySpec(news) !== keySpec(olds))
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
        output?.keyName ?? olds?.name ?? (yield* createObjectName(id));
      const observed = yield* getKey(
        subscriptionId,
        resourceGroup,
        vault,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = { ...toKeyAttrs(resourceGroup, name, observed), vault };
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KeyVault");
      const { resourceGroup, vault } = news;
      const name =
        news.name ?? output?.keyName ?? (yield* createObjectName(id));

      // Observe, then ensure. The PUT is create-if-not-exist: on an existing
      // key it returns the key unchanged, so there is nothing to sync.
      let observed = yield* getKey(subscriptionId, resourceGroup, vault, name);
      if (observed === undefined) {
        observed = yield* keyvault.CreateKeyIfNotExist({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vaultName: vault,
          keyName: name,
          tags: yield* desiredTags(id, news.tags),
          properties: toKeyProperties(news),
        });
      }
      return { ...toKeyAttrs(resourceGroup, name, observed), vault };
    }),

    // ARM has no key delete; the key is removed with its vault.
    delete: Effect.fn(function* () {}),

    nuke: {
      dependsOn: ["Azure.KeyVault.Vault", "Azure.Resources.ResourceGroup"],
    },
  });
