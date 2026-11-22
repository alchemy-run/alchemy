import { createHash } from "node:crypto";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
import { GroupedResource } from "../StackResourceGroup.ts";
import { createObjectName, lower } from "./common.ts";

/** Secret lifetime attributes. Times are Unix seconds. */
export interface SecretAttributes {
  /**
   * Whether the secret can be read.
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
}

export interface SecretProps {
  /**
   * Resource group of the vault. Changing it replaces the secret.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
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
  /**
   * Content type hint, e.g. `text/plain` or `application/json`.
   * @default none
   */
  contentType?: string;
  /**
   * Lifetime attributes.
   * @default enabled, with no not-before or expiry time
   */
  attributes?: SecretAttributes;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
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
 * A secret in an Azure Key Vault (`Microsoft.KeyVault/vaults/secrets`),
 * managed through Azure Resource Manager: a versioned value such as an API
 * key, a password, or a connection string.
 *
 * Alchemy never stores the value in state, only its SHA-256 hash; a new
 * value writes a new version. Bind the secret to a runtime to read it with
 * **Key Vault Secrets User** on this secret only.
 *
 * :::caution[Changing `name`, `vault`, or `resourceGroup` replaces the secret]
 * Alchemy creates the new secret and disables the old one (ARM has no
 * secret delete).
 * :::
 *
 * @see https://learn.microsoft.com/azure/key-vault/secrets/about-secrets
 *
 * ### Creating a Secret
 * **Example:** Store a database password from config
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("secrets");
 * const password = yield* Azure.KeyVault.Secret("db-password", {
 *   vault: vault.vaultName,
 *   value: Config.redacted("DB_PASSWORD"),
 *   contentType: "text/plain",
 * });
 * ```
 *
 * **Example:** Generate a random API key once
 * ```typescript
 * const initial = yield* Alchemy.Random("InitialApiKey");
 * const apiKey = yield* Azure.KeyVault.Secret("api-key", {
 *   vault: vault.vaultName,
 *   value: initial.text,
 *   contentType: "text/plain",
 * });
 * ```
 *
 * **Example:** JSON value with a fixed name
 * ```typescript
 * const smtp = yield* Azure.KeyVault.Secret("smtp", {
 *   vault: vault.vaultName,
 *   name: "smtp-credentials",
 *   value: Redacted.make(JSON.stringify({ user: "mailer", password: "…" })),
 *   contentType: "application/json",
 * });
 * ```
 *
 * ### Expiring Secrets
 * **Example:** Secret that expires
 * ```typescript
 * const token = yield* Azure.KeyVault.Secret("api-token", {
 *   vault: vault.vaultName,
 *   value: Config.redacted("API_TOKEN"),
 *   attributes: { expires: 1_893_456_000 }, // Unix seconds
 * });
 * ```
 *
 * **Example:** Disable a secret without removing it
 * ```typescript
 * const token = yield* Azure.KeyVault.Secret("api-token", {
 *   vault: vault.vaultName,
 *   value: Config.redacted("API_TOKEN"),
 *   attributes: { enabled: false },
 * });
 * ```
 *
 * ### Binding to a runtime
 * `SecretRead` grants **Key Vault Secrets User** on this secret only.
 * `SecretWrite` grants a custom role with only `setSecret` and `update`,
 * and `SecretReadWrite` grants both. The vault must use Azure RBAC (the
 * default). On an Azure Function, Web App, Container App, container group,
 * or VM the role goes to the host's managed identity; any other host gets
 * an Entra service principal.
 *
 * **Example:** Check an API key in an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const secret = yield* ApiKey;
 *     const apiKey = yield* Azure.KeyVault.SecretRead(secret);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         // the latest version on every request, so a rotation applies at once
 *         const expected = yield* apiKey.get();
 *         const ok = request.headers["x-api-key"] === Redacted.value(expected);
 *         return HttpServerResponse.text(ok ? "ok" : "unauthorized", { status: ok ? 200 : 401 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.SecretReadHttp)),
 * ) {}
 * ```
 *
 * **Example:** Read a secret from a Cloudflare Worker
 * ```typescript
 * // init: an Entra service principal for the Worker gets Key Vault Secrets User
 * const secret = yield* Azure.KeyVault.SecretRead(vaultSecret);
 *
 * // runtime
 * const value = yield* secret.get();
 * // …provided with Effect.provide(Azure.KeyVault.SecretReadHttp)
 * ```
 *
 * ### Runtime Operations
 * **Example:** Read the latest or a specific version
 * ```typescript
 * const latest = yield* apiKey.get();
 * const pinned = yield* apiKey.get("4f1c7c0e2b8a4d5f9e3a1b2c3d4e5f60");
 * const versions = yield* apiKey.versions(); // metadata only, no values
 * ```
 *
 * **Example:** Rotate the secret from the runtime
 * ```typescript
 * // init
 * const apiKey = yield* Azure.KeyVault.SecretReadWrite(secret);
 *
 * // runtime
 * const next = yield* Effect.sync(() => randomBytes(32).toString("hex"));
 * const written = yield* apiKey.set(Redacted.make(next), { contentType: "text/plain" });
 * yield* apiKey.update(previousVersion, { enabled: false });
 * // …provided with Effect.provide(Azure.KeyVault.SecretReadWriteHttp)
 * ```
 *
 * A version written at runtime is not tracked by this resource: the next
 * deploy writes the declared value again only if that value changed.
 *
 * ### Event Sources
 * **Example:** React to new secret versions
 * ```typescript
 * yield* Azure.EventGrid.consumeEvents(
 *   "SecretVersions",
 *   {
 *     scope: vault.vaultId,
 *     includedEventTypes: ["Microsoft.KeyVault.SecretNewVersionCreated"],
 *     subjectBeginsWith: apiKey.secretName,
 *   },
 *   (event) => Effect.log(`new version of ${event.subject}`),
 * );
 * // …provided with Effect.provide(Azure.Functions.EventGridEventSource)
 * ```
 *
 * ### Deleting a Secret
 * ARM can create, update, and read secrets but has no delete operation.
 * Destroying the resource *disables* the secret so nothing can read it;
 * the secret itself goes away with its vault.
 *
 * @resource
 */
export const Secret = GroupedResource<Secret>("Azure.KeyVault.Secret");

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
      const name = output?.secretName ?? olds?.name ?? (yield* createObjectName(id));
      const observed = yield* getSecret(subscriptionId, resourceGroup, vault, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vault, name, observed, output?.valueHash ?? "");
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KeyVault");
      const { resourceGroup, vault } = news;
      const name = news.name ?? output?.secretName ?? (yield* createObjectName(id));
      const tags = yield* desiredTags(id, news.tags);
      const valueHash = yield* hashValue(news.value);
      const value = Redacted.isRedacted(news.value) ? Redacted.value(news.value) : news.value;
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
      let observed = yield* getSecret(subscriptionId, resourceGroup, vault, name);

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
        news.contentType !== undefined && current.contentType !== news.contentType;
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
