import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Secret } from "./Secret.ts";
import type { ReadSecretClient, SecretVersionInfo } from "./SecretRead.ts";
import { SecretValueMissing } from "./SecretRead.ts";
import type { SecretWriteOptions, WriteSecretClient } from "./SecretWrite.ts";
import type { Vault } from "./Vault.ts";

/**
 * Shared scaffolding for the Key Vault secret bindings: resolves the
 * distilled `keyvault-secrets` operation once when the layer is built,
 * injects the bound secret's (or vault's) identifiers, and assigns the
 * binding's roles on that secret (or vault) at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/** Key Vault secret data actions (Azure RBAC). */
export const SecretDataAction = {
  getSecret: "Microsoft.KeyVault/vaults/secrets/getSecret/action",
  setSecret: "Microsoft.KeyVault/vaults/secrets/setSecret/action",
  readMetadata: "Microsoft.KeyVault/vaults/secrets/readMetadata/action",
  update: "Microsoft.KeyVault/vaults/secrets/update/action",
  delete: "Microsoft.KeyVault/vaults/secrets/delete",
  backup: "Microsoft.KeyVault/vaults/secrets/backup/action",
  purge: "Microsoft.KeyVault/vaults/secrets/purge/action",
  recover: "Microsoft.KeyVault/vaults/secrets/recover/action",
  restore: "Microsoft.KeyVault/vaults/secrets/restore/action",
} as const;

/**
 * A role a secret binding assigns: a built-in role GUID, or a custom role
 * (`Azure.Authorization.RoleDefinition`, defined once per stack at the
 * subscription and assigned only on the bound resource) with exactly
 * `dataActions`.
 */
export type SecretGrant =
  | { readonly builtIn: string }
  | { readonly role: string; readonly dataActions: readonly string[] };

/** Custom role per binding kind; the logical ID is `AzureKeyVault<role>Role`. */
export const SecretRole = {
  GetSecret: { role: "GetSecret", dataActions: [SecretDataAction.getSecret] },
  SetSecret: { role: "SetSecret", dataActions: [SecretDataAction.setSecret] },
  UpdateSecret: { role: "UpdateSecret", dataActions: [SecretDataAction.update] },
  DeleteSecret: { role: "DeleteSecret", dataActions: [SecretDataAction.delete] },
  ReadSecretMetadata: { role: "ReadSecretMetadata", dataActions: [SecretDataAction.readMetadata] },
  BackupSecret: { role: "BackupSecret", dataActions: [SecretDataAction.backup] },
  PurgeDeletedSecret: { role: "PurgeDeletedSecret", dataActions: [SecretDataAction.purge] },
  RecoverDeletedSecret: { role: "RecoverDeletedSecret", dataActions: [SecretDataAction.recover] },
  RestoreSecret: { role: "RestoreSecret", dataActions: [SecretDataAction.restore] },
  SecretWrite: {
    role: "SecretWrite",
    dataActions: [SecretDataAction.setSecret, SecretDataAction.update],
  },
} as const satisfies Record<string, SecretGrant>;

/** Assign `grants` on `scope` to the host, creating the custom roles they name. */
const GrantKeyVaultRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: Secret | Vault,
    scope: Output.Output<string, never>,
    grants: readonly SecretGrant[],
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        if ("builtIn" in grant) {
          roleAssignments.push({ roleDefinitionId: grant.builtIn, scope });
          continue;
        }
        const role = yield* AzureRoleDefinition(`AzureKeyVault${grant.role}Role`, {
          description: `Alchemy Key Vault binding: ${grant.dataActions.join(", ")}`,
          permissions: [{ dataActions: [...grant.dataActions] }],
        });
        roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope });
      }
      yield* bind`${tag}(${resource})`({ roleAssignments });
    }
  });
});

/** `https://{vault}.vault.azure.net`, resolved per call at runtime. */
const vaultBaseUrlOf = (vaultName: Output.Output<string, never>) =>
  Output.interpolate`https://${vaultName}.vault.azure.net`;

/** Where a secret lives, resolved per call at runtime. */
export interface SecretAddress {
  readonly tag: string;
  readonly at: Effect.Effect<{ vaultBaseUrl: string; secretName: string }>;
}

const secretAddressOf = Effect.fn(function* (tag: string, secret: Secret) {
  const vaultBaseUrl = yield* vaultBaseUrlOf(secret.vault);
  const secretName = yield* secret.secretName;
  return {
    tag: `${tag}(${secret.LogicalId})`,
    at: Effect.all({ vaultBaseUrl, secretName }),
  } satisfies SecretAddress;
});

/**
 * Build the impl Effect for a secret-scoped operation whose request
 * carries `vaultBaseUrl` + `secretName` (`GetSecret`, `SetSecret`,
 * `DeleteSecret`, …): the runtime callable injects the bound
 * {@link Secret}'s vault URL and name, and the deploy-time half assigns
 * `grants` on the secret.
 */
export const makeSecretHttpBinding = <
  I extends { vaultBaseUrl: string; secretName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.KeyVault.GetSecret`. */
  tag: string;
  /** The distilled operation; the vault URL and secret name are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Roles assigned on the secret. */
  grants: readonly SecretGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantKeyVaultRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (secret: Secret) {
      yield* grant(options.tag, secret, secret.secretId, options.grants);
      const address = yield* secretAddressOf(options.tag, secret);
      return Effect.fn(address.tag)(function* (request?: Omit<I, "vaultBaseUrl" | "secretName">) {
        const where = yield* address.at;
        return yield* op({ ...request, ...where } as I);
      });
    });
  });

/**
 * Build the impl Effect for a vault-scoped operation whose request carries
 * only `vaultBaseUrl` (`GetSecrets`, `GetDeletedSecrets`, `RestoreSecret`):
 * the runtime callable injects the bound {@link Vault}'s URL, and the
 * deploy-time half assigns `grants` on the vault.
 */
export const makeVaultSecretsHttpBinding = <I extends { vaultBaseUrl: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.KeyVault.GetSecrets`. */
  tag: string;
  /** The distilled operation; the vault URL is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Roles assigned on the vault. */
  grants: readonly SecretGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantKeyVaultRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (vault: Vault) {
      yield* grant(options.tag, vault, vault.vaultId, options.grants);
      const vaultBaseUrl = yield* vaultBaseUrlOf(vault.vaultName);
      return Effect.fn(`${options.tag}(${vault.LogicalId})`)(function* (
        request?: Omit<I, "vaultBaseUrl">,
      ) {
        const base = yield* vaultBaseUrl;
        return yield* op({ ...request, vaultBaseUrl: base } as I);
      });
    });
  });

/** The version segment of a secret identifier (`…/secrets/{name}/{version}`). */
const versionOf = (id: string | undefined) => {
  const parts = (id ?? "").split("/secrets/")[1]?.split("/");
  return parts?.[1] || undefined;
};

const toVersionInfo = (item: secrets.SecretItem | secrets.SecretBundle): SecretVersionInfo => ({
  id: item.id,
  version: versionOf(item.id),
  enabled: item.attributes?.enabled,
  created: item.attributes?.created,
  updated: item.attributes?.updated,
  notBefore: item.attributes?.nbf,
  expires: item.attributes?.exp,
  contentType: item.contentType,
  tags: item.tags,
});

const attributesOf = (options: SecretWriteOptions | undefined) =>
  options?.enabled === undefined &&
  options?.notBefore === undefined &&
  options?.expires === undefined
    ? undefined
    : { enabled: options.enabled, nbf: options.notBefore, exp: options.expires };

export const makeReadSecretClient = Effect.gen(function* () {
  const getSecret = yield* AzureBindings.withCredentials(secrets.GetSecret);
  const getVersions = yield* AzureBindings.withCredentials(secrets.GetSecretVersions);
  return (address: SecretAddress): ReadSecretClient => ({
    get: Effect.fn(`${address.tag}.get`)(function* (version?: string) {
      const where = yield* address.at;
      const bundle = yield* getSecret({ ...where, secretVersion: version ?? "" });
      if (bundle.value === undefined) {
        return yield* new SecretValueMissing({
          secretName: where.secretName,
          message: `Key Vault secret ${where.secretName} has no value`,
        });
      }
      return Redacted.make(bundle.value);
    }),
    versions: Effect.fn(`${address.tag}.versions`)(function* () {
      const where = yield* address.at;
      const items = yield* Stream.runCollect(getVersions.items(where));
      return Array.from(items, toVersionInfo);
    }),
  });
});

export const makeWriteSecretClient = Effect.gen(function* () {
  const setSecret = yield* AzureBindings.withCredentials(secrets.SetSecret);
  const updateSecret = yield* AzureBindings.withCredentials(secrets.UpdateSecret);
  return (address: SecretAddress): WriteSecretClient => ({
    set: Effect.fn(`${address.tag}.set`)(function* (
      value: string | Redacted.Redacted<string>,
      options?: SecretWriteOptions,
    ) {
      const where = yield* address.at;
      const bundle = yield* setSecret({
        ...where,
        value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
        contentType: options?.contentType,
        tags: options?.tags,
        attributes: attributesOf(options),
      });
      return toVersionInfo(bundle);
    }),
    update: Effect.fn(`${address.tag}.update`)(function* (
      version: string,
      options: SecretWriteOptions,
    ) {
      const where = yield* address.at;
      const bundle = yield* updateSecret({
        ...where,
        secretVersion: version,
        contentType: options.contentType,
        tags: options.tags,
        attributes: attributesOf(options),
      });
      return toVersionInfo(bundle);
    }),
  });
});

/**
 * Build a Read/Write/ReadWrite secret binding that assigns `grants` on the
 * secret and returns the client `makeClient` builds.
 */
export const makeSecretLevelBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.KeyVault.SecretRead`. */
  tag: string;
  /** Roles assigned on the secret. */
  grants: readonly SecretGrant[];
  makeClient: Effect.Effect<(address: SecretAddress) => Client>;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantKeyVaultRoles;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (secret: Secret) {
      yield* grant(options.tag, secret, secret.secretId, options.grants);
      const address = yield* secretAddressOf(options.tag, secret);
      return makeClient(address);
    });
  });
