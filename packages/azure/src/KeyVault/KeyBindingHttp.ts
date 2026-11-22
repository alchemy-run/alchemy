import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Key } from "./Key.ts";
import type { KeyOperationRequest, VaultKeyOperationRequest } from "./KeyTypes.ts";
import type { Vault } from "./Vault.ts";

/**
 * Shared scaffolding for the Key Vault key bindings (`keyvault-keys` data
 * plane). Every `{Op}Http.ts` is a thin `Layer.effect(Cap, make…({ … }))`
 * over one of the builders below; only the operation and its role differ.
 *
 * NOT exported from `index.ts`.
 */

/** Data actions of the Key Vault keys data plane. */
const KEYS = "Microsoft.KeyVault/vaults/keys";
const ROTATION_POLICIES = "Microsoft.KeyVault/vaults/keyrotationpolicies";

/**
 * The role a key binding assigns: a built-in role whose data actions are
 * exactly the operation's, or else a custom role (one per data-action set,
 * shared by every host in the stack) holding only those data actions.
 */
export interface KeyRole {
  /** Logical ID of the custom role, or the built-in role GUID. */
  readonly id: string;
  /** Data actions the role grants. */
  readonly dataActions: readonly string[];
  /** Whether {@link id} is a built-in role GUID. */
  readonly builtIn?: boolean;
}

const custom = (name: string, ...dataActions: string[]): KeyRole => ({
  id: `AzureKeyVaultKeys${name}Role`,
  dataActions,
});

/** The roles of the key bindings, by data-action set. */
export const KeyRoles = {
  /** `keys/read`: get a key, its versions, a deleted key; list keys and deleted keys. */
  Read: custom("Read", `${KEYS}/read`),
  Update: custom("Update", `${KEYS}/update/action`),
  Create: custom("Create", `${KEYS}/create/action`),
  Import: custom("Import", `${KEYS}/import/action`),
  Rotate: custom("Rotate", `${KEYS}/rotate/action`),
  Delete: custom("Delete", `${KEYS}/delete`),
  Backup: custom("Backup", `${KEYS}/backup/action`),
  Restore: custom("Restore", `${KEYS}/restore/action`),
  Recover: custom("Recover", `${KEYS}/recover/action`),
  Purge: custom("Purge", `${KEYS}/purge/action`),
  Encrypt: custom("Encrypt", `${KEYS}/encrypt/action`),
  Decrypt: custom("Decrypt", `${KEYS}/decrypt/action`),
  Wrap: custom("Wrap", `${KEYS}/wrap/action`),
  Unwrap: custom("Unwrap", `${KEYS}/unwrap/action`),
  Sign: custom("Sign", `${KEYS}/sign/action`),
  Verify: custom("Verify", `${KEYS}/verify/action`),
  ReadRotationPolicy: custom("ReadRotationPolicy", `${ROTATION_POLICIES}/read`),
  WriteRotationPolicy: custom("WriteRotationPolicy", `${ROTATION_POLICIES}/write`),
  /** Built-in **Key Vault Crypto Service Release User**: exactly `keys/release/action`. */
  Release: {
    id: "08bbd89e-9f13-488c-ac41-acfcb10c90ab",
    dataActions: [`${KEYS}/release/action`],
    builtIn: true,
  },
} satisfies Record<string, KeyRole>;

type Grant = (
  tag: string,
  resource: Key | Vault,
  scope: Output.Output<string>,
  role: KeyRole,
) => Effect.Effect<void>;

/**
 * Deploy-time grant: assigns `role` on `scope` (the bound key or vault) to
 * the host, creating the custom role definition first when there is one.
 */
const KeyGrants: Effect.Effect<Grant> = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Bindings only bind at deploy, so a host bundle drops the role definitions.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => Effect.void;
  const AzureRoleDefinition = yield* RoleDefinition;
  return Effect.fn(function* (tag, resource, scope, role) {
    const roleDefinitionId = role.builtIn
      ? role.id
      : (yield* AzureRoleDefinition(role.id, {
          description: `Alchemy Key Vault key binding: ${role.dataActions.join(", ")}`,
          permissions: [{ dataActions: [...role.dataActions] }],
        })).roleDefinitionId;
    yield* bind`${tag}(${resource})`({
      roleAssignments: [{ roleDefinitionId, scope }],
    });
  });
});

/**
 * Build the impl Effect of an operation on one key (`GetKey`, `Encrypt`,
 * `RotateKey`, …): the runtime callable injects the bound {@link Key}'s
 * vault URL and name (and the latest version when the operation takes
 * `keyVersion` and the caller omits it); the deploy-time half assigns
 * `role` on the key.
 */
export const makeKeyOperationBinding = <
  I extends { vaultBaseUrl: string; keyName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.KeyVault.Encrypt`. */
  tag: string;
  /** The distilled `keyvault-keys` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** Role assigned on the key. */
  role: KeyRole;
  /** Whether the request has a `keyVersion` path label. */
  versioned?: boolean;
}) =>
  Effect.gen(function* () {
    const grant = yield* KeyGrants;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (key: Key) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* grant(options.tag, key, key.keyId, options.role);
      }
      const vaultBaseUrl = yield* Output.interpolate`https://${key.vault}.vault.azure.net`;
      const keyName = yield* key.keyName;
      return Effect.fn(`${options.tag}(${key.LogicalId})`)(function* (
        request?: KeyOperationRequest<I>,
      ) {
        const base = yield* vaultBaseUrl;
        const name = yield* keyName;
        return yield* op({
          // An empty `keyVersion` segment addresses the latest version.
          ...(options.versioned ? { keyVersion: "" } : {}),
          ...request,
          vaultBaseUrl: base,
          keyName: name,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect of a vault-wide key operation (`GetKeys`,
 * `GetDeletedKeys`, `RestoreKey`): the runtime callable injects the bound
 * {@link Vault}'s URL; the deploy-time half assigns `role` on the vault.
 */
export const makeVaultKeyOperationBinding = <I extends { vaultBaseUrl: string }, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.KeyVault.GetKeys`. */
  tag: string;
  /** The distilled `keyvault-keys` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** Role assigned on the vault. */
  role: KeyRole;
}) =>
  Effect.gen(function* () {
    const grant = yield* KeyGrants;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (vault: Vault) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* grant(options.tag, vault, vault.vaultId, options.role);
      }
      const vaultUri = yield* vault.vaultUri;
      return Effect.fn(`${options.tag}(${vault.LogicalId})`)(function* (
        request?: VaultKeyOperationRequest<I>,
      ) {
        const base = yield* vaultUri;
        return yield* op({ ...request, vaultBaseUrl: base } as I);
      });
    });
  });
