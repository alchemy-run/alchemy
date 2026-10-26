import * as keyvault from "@distilled.cloud/azure/keyvault";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { desiredTags, ensureRegistered, isOwned, orUndefinedIfNotFound, userTags } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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
  /**
   * Not-before time (Unix seconds).
   * @default none
   */
  notBefore?: number;
  /**
   * Expiry time (Unix seconds).
   * @default never expires
   */
  expires?: number;
  /**
   * Automatic rotation policy.
   * @default no automatic rotation
   */
  rotationPolicy?: KeyRotationPolicy;
  /**
   * User tags. Alchemy ownership tags are merged in automatically. Tags are
   * written only when the key is created.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface KeyProps extends KeyCommonProps {
  /**
   * Resource group of the vault. Changing it replaces the key.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
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
 * A cryptographic key in an Azure Key Vault (`Microsoft.KeyVault/vaults/keys`),
 * managed through Azure Resource Manager. The private key never leaves the
 * vault: your runtime calls Key Vault to encrypt, decrypt, sign, verify,
 * wrap, and unwrap with it.
 *
 * Bind the key with one binding per operation (`Encrypt`, `Sign`, …); each
 * grants a custom role with exactly that one data action on this key.
 * Rotate key material with `rotationPolicy`: a rotation adds a version and
 * keeps the old ones, so data encrypted earlier still decrypts.
 *
 * :::caution[Changing any key property replaces the key]
 * ARM creates keys but cannot change or delete them. A change to `name`,
 * `vault`, `kty`, `keySize`, `curveName`, `keyOps`, `enabled`, the dates,
 * `rotationPolicy`, or `tags` creates a new key; the old one stays in the
 * vault until the vault is deleted. Data encrypted with the old key does
 * not decrypt with the new one.
 * :::
 *
 * @see https://learn.microsoft.com/azure/key-vault/keys/about-keys
 *
 * ### Creating a Key
 * **Example:** RSA encryption key
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("keys");
 * const dataKey = yield* Azure.KeyVault.Key("data-key", {
 *   vault: vault.vaultName,
 *   kty: "RSA",
 *   keySize: 2048,
 *   keyOps: ["encrypt", "decrypt"],
 * });
 * ```
 *
 * **Example:** Elliptic-curve signing key
 * ```typescript
 * const signing = yield* Azure.KeyVault.Key("signing", {
 *   vault: vault.vaultName,
 *   kty: "EC",
 *   curveName: "P-256",
 *   keyOps: ["sign", "verify"],
 * });
 * ```
 *
 * **Example:** HSM-protected key on a premium vault
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("hsm-keys", { sku: "premium" });
 * const key = yield* Azure.KeyVault.Key("cmk", {
 *   vault: vault.vaultName,
 *   kty: "RSA-HSM",
 *   keySize: 3072,
 * });
 * ```
 *
 * ### Customer-Managed Keys
 * Services that encrypt with your key take its `keyUri` (the latest
 * version, so they follow rotations).
 *
 * **Example:** Key for customer-managed encryption
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("keys", {
 *   enablePurgeProtection: true,
 * });
 * const key = yield* Azure.KeyVault.Key("cmk", {
 *   vault: vault.vaultName,
 *   kty: "RSA",
 *   keySize: 3072,
 *   keyOps: ["wrapKey", "unwrapKey"],
 * });
 * // pass key.keyUri to the service's encryption settings
 * ```
 *
 * ### Rotation
 * **Example:** Rotate every 90 days
 * ```typescript
 * const key = yield* Azure.KeyVault.Key("cmk", {
 *   vault: vault.vaultName,
 *   rotationPolicy: {
 *     expiryTime: "P1Y",
 *     lifetimeActions: [{ action: "rotate", timeAfterCreate: "P90D" }],
 *   },
 * });
 * ```
 *
 * **Example:** Notify 30 days before expiry
 * ```typescript
 * const key = yield* Azure.KeyVault.Key("signing", {
 *   vault: vault.vaultName,
 *   kty: "EC",
 *   rotationPolicy: {
 *     expiryTime: "P1Y",
 *     lifetimeActions: [{ action: "notify", timeBeforeExpiry: "P30D" }],
 *   },
 * });
 * ```
 *
 * ### Binding to a runtime
 * Each operation is its own binding with its own custom role on this key:
 * `Encrypt`, `Decrypt`, `Sign`, `Verify`, `WrapKey`, and `UnwrapKey`.
 * `KeyRead` reads the key and its public half; `KeyWrite` creates
 * versions, rotates, and changes the rotation policy. The vault must use
 * Azure RBAC (the default).
 *
 * **Example:** Encrypt and decrypt in an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* DataKey;
 *     const encrypt = yield* Azure.KeyVault.Encrypt(key);
 *     const decrypt = yield* Azure.KeyVault.Decrypt(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const value = Buffer.from("hello", "utf8").toString("base64url");
 *         const sealed = yield* encrypt({ alg: "RSA-OAEP-256", value });
 *         const keyVersion = sealed.kid?.split("/").pop() ?? "";
 *         const opened = yield* decrypt({ alg: "RSA-OAEP-256", keyVersion, value: sealed.value ?? "" });
 *         return HttpServerResponse.text(Buffer.from(opened.value ?? "", "base64url").toString());
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide([Azure.KeyVault.EncryptHttp, Azure.KeyVault.DecryptHttp])),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Sign a digest and verify it
 * ```typescript
 * // init
 * const sign = yield* Azure.KeyVault.Sign(signingKey);
 * const verify = yield* Azure.KeyVault.Verify(signingKey);
 *
 * // runtime: `digest` is the base64url SHA-256 of the message
 * const signed = yield* sign({ alg: "ES256", value: digest });
 * const keyVersion = signed.kid?.split("/").pop() ?? "";
 * const checked = yield* verify({ alg: "ES256", keyVersion, digest, value: signed.value ?? "" });
 * // checked.value === true
 * // …provided with Azure.KeyVault.SignHttp and Azure.KeyVault.VerifyHttp
 * ```
 *
 * **Example:** Publish the public key as a JWKS
 * ```typescript
 * // init
 * const signingKeyRead = yield* Azure.KeyVault.KeyRead(signingKey);
 *
 * // runtime
 * const bundle = yield* signingKeyRead.get();
 * const { kid, kty, crv, x, y } = bundle.key ?? {};
 * // …provided with Effect.provide(Azure.KeyVault.KeyReadHttp)
 * ```
 *
 * **Example:** Wrap a data-encryption key
 * ```typescript
 * // init
 * const wrapKey = yield* Azure.KeyVault.WrapKey(key);
 *
 * // runtime
 * const wrapped = yield* wrapKey({ alg: "RSA-OAEP-256", value: dek.toString("base64url") });
 * // …provided with Effect.provide(Azure.KeyVault.WrapKeyHttp)
 * ```
 *
 * **Example:** Rotate on demand
 * ```typescript
 * // init
 * const cmk = yield* Azure.KeyVault.KeyWrite(key);
 *
 * // runtime
 * const bundle = yield* cmk.rotate();
 * // …provided with Effect.provide(Azure.KeyVault.KeyWriteHttp)
 * ```
 *
 * ### Event Sources
 * **Example:** React to new key versions
 * ```typescript
 * yield* Azure.EventGrid.consumeEvents(
 *   "KeyVersions",
 *   {
 *     scope: vault.vaultId,
 *     includedEventTypes: ["Microsoft.KeyVault.KeyNewVersionCreated"],
 *   },
 *   (event) => Effect.log(`new version of ${event.subject}`),
 * );
 * // …provided with Effect.provide(Azure.Functions.EventGridEventSource)
 * ```
 *
 * ### Deleting a Key
 * ARM has no key delete. Destroying the resource leaves the key in the
 * vault; it goes away with its vault.
 *
 * @resource
 */
export const Key = GroupedResource<Key>("Azure.KeyVault.Key");

/** Request body for a create-if-not-exist key PUT. */
export const toKeyProperties = (props: KeyCommonProps): keyvault.KeyPropertiesInput => {
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
            lifetimeActions: props.rotationPolicy.lifetimeActions?.map((entry) => ({
              action: { type: entry.action },
              trigger: {
                timeAfterCreate: entry.timeAfterCreate,
                timeBeforeExpiry: entry.timeBeforeExpiry,
              },
            })),
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
  orUndefinedIfNotFound(keyvault.GetKey({ subscriptionId, resourceGroupName, vaultName, keyName }));

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
      const name = output?.keyName ?? olds?.name ?? (yield* createObjectName(id));
      const observed = yield* getKey(subscriptionId, resourceGroup, vault, name);
      if (observed === undefined) return undefined;
      const attrs = { ...toKeyAttrs(resourceGroup, name, observed), vault };
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KeyVault");
      const { resourceGroup, vault } = news;
      const name = news.name ?? output?.keyName ?? (yield* createObjectName(id));

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
