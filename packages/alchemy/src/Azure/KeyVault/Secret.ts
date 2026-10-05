import * as keyvault from "@distilled.cloud/azure/keyvault";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createObjectName, lower } from "./common.ts";

/** Secret lifetime attributes. Times are Unix seconds. */
export interface SecretAttributes {
  /**
   * Whether the secret can be read.
   * @default true
   */
  enabled?: boolean;
  /** Not-before time (Unix seconds). */
  notBefore?: number;
  /** Expiry time (Unix seconds). */
  expires?: number;
}

export interface SecretProps {
  /** Resource group of the vault. Changing it replaces the secret. */
  resourceGroup: string;
  /** Vault that holds the secret. Changing it replaces the secret. */
  vault: string;
  /**
   * Secret name: 1-127 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the secret.
   */
  name?: string;
  /**
   * Secret value. Azure never returns it, so a change is detected against
   * the hash recorded at the last deploy; each change writes a new version.
   */
  value: string | Redacted.Redacted<string>;
  /** Content type hint, e.g. `text/plain` or `application/json`. */
  contentType?: string;
  /** Lifetime attributes. */
  attributes?: SecretAttributes;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Secret extends Resource<
  "Azure.KeyVault.Secret",
  SecretProps,
  {
    /** Name of the secret. */
    secretName: string;
    /** ARM resource ID of the secret; use it as a role-assignment scope. */
    secretId: string;
    /** Vault that holds the secret. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** Data-plane URI of the latest version (Key Vault references use it). */
    secretUri: string;
    /** Data-plane URI of the current version; changes with every new value. */
    secretUriWithVersion: string;
    /** Content type hint. */
    contentType: string | undefined;
    /** Whether the secret is enabled. */
    enabled: boolean;
    /** SHA-256 of the value last written (never the value itself). */
    valueHash: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A secret in an Azure Key Vault, managed through Azure Resource Manager.
 *
 * ARM can create, update, and read secrets but has no delete operation
 * (deletion is a data-plane call). Destroying the resource therefore
 * *disables* the secret so it can no longer be read; the secret itself is
 * removed together with its vault.
 *
 * @see https://learn.microsoft.com/azure/key-vault/secrets/about-secrets
 *
 * ### Creating a Secret
 * **Example:** Store a database password
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("secrets", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const password = yield* Azure.KeyVault.Secret("db-password", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   value: Redacted.make(process.env.DB_PASSWORD!),
 *   contentType: "text/plain",
 * });
 * ```
 *
 * ### Expiring Secrets
 * **Example:** Secret that expires
 * ```typescript
 * const token = yield* Azure.KeyVault.Secret("api-token", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   value: Redacted.make(apiToken),
 *   attributes: { expires: 1_893_456_000 },
 * });
 * ```
 *
 * @resource
 */
export const Secret = Resource<Secret>("Azure.KeyVault.Secret");

type ObservedSecret = keyvault.GetSecretResponse;

const getSecret = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  secretName: string,
) =>
  orUndefinedIfNotFound(
    keyvault.GetSecret({
      subscriptionId,
      resourceGroupName,
      vaultName,
      secretName,
    }),
  );

const hashValue = (value: string | Redacted.Redacted<string>) =>
  Effect.sync(() =>
    createHash("sha256")
      .update(Redacted.isRedacted(value) ? Redacted.value(value) : value)
      .digest("hex"),
  );

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  secret: ObservedSecret,
  valueHash: string,
): Secret["Attributes"] => ({
  secretName: name,
  secretId: secret.id ?? "",
  vault,
  resourceGroup,
  secretUri: secret.properties.secretUri ?? "",
  secretUriWithVersion: secret.properties.secretUriWithVersion ?? "",
  contentType: secret.properties.contentType,
  enabled: secret.properties.attributes?.enabled ?? true,
  valueHash,
  tags: userTags(secret.tags),
});

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    stables: ["secretName", "secretId", "vault", "resourceGroup", "secretUri"],

    // Secrets vanish with their vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.vault) !== lower(output.vault) ||
        (news.name !== undefined && news.name !== output.secretName)
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
        output?.secretName ?? olds?.name ?? (yield* createObjectName(id));
      const observed = yield* getSecret(
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
        observed,
        output?.valueHash ?? "",
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KeyVault");
      const { resourceGroup, vault } = news;
      const name =
        news.name ?? output?.secretName ?? (yield* createObjectName(id));
      const tags = yield* desiredTags(id, news.tags);
      const valueHash = yield* hashValue(news.value);
      const value = Redacted.isRedacted(news.value)
        ? Redacted.value(news.value)
        : news.value;
      const attributes: keyvault.AttributesInput = {
        enabled: news.attributes?.enabled ?? true,
        nbf: news.attributes?.notBefore,
        exp: news.attributes?.expires,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: vault,
        secretName: name,
      };

      // Observe.
      let observed = yield* getSecret(
        subscriptionId,
        resourceGroup,
        vault,
        name,
      );

      // Ensure. The value is unobservable, so a PUT (new version) runs when
      // the secret is missing, after adoption, or when the value changed.
      if (observed === undefined || output?.valueHash !== valueHash) {
        observed = yield* keyvault.SecretsCreateOrUpdate({
          ...where,
          tags,
          properties: { value, contentType: news.contentType, attributes },
        });
      }

      // Sync attributes, content type, and tags against observed state.
      const current = observed.properties;
      const attributesChanged =
        (current.attributes?.enabled ?? true) !== attributes.enabled ||
        current.attributes?.nbf !== attributes.nbf ||
        current.attributes?.exp !== attributes.exp;
      const contentTypeChanged =
        news.contentType !== undefined &&
        current.contentType !== news.contentType;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (attributesChanged || contentTypeChanged || tagsChanged) {
        // ARM rejects a secret PATCH without the value.
        observed = yield* keyvault.UpdateSecret({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: {
            value,
            contentType: contentTypeChanged ? news.contentType : undefined,
            attributes: attributesChanged ? attributes : undefined,
          },
        });
      }

      return toAttrs(resourceGroup, vault, name, observed, valueHash);
    }),

    // ARM has no secret delete; disable it so it can no longer be read.
    // ARM requires the value on PATCH, so this needs the deployed props
    // (not available to account-wide nuke, where the vault goes anyway).
    delete: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const value = olds?.value;
      if (value === undefined) return;
      yield* ignoreNotFound(
        keyvault.UpdateSecret({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vaultName: output.vault,
          secretName: output.secretName,
          properties: {
            value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
            attributes: { enabled: false },
          },
        }),
      );
    }),

    nuke: {
      dependsOn: ["Azure.KeyVault.Vault", "Azure.Resources.ResourceGroup"],
    },
  });
