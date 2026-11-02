import { ConfigError } from "@distilled.cloud/core/errors";
import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import { appRoleVaultCredentials, VaultCredentials } from "@distilled.cloud/stackit/Vault";
import * as Binding from "alchemy/Binding";
import type { ResourceLike } from "alchemy/Resource";
import { CurrentRuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as StackitBindings from "../StackitBindings.ts";
import { AppRole } from "./AppRole.ts";
import { AppRoleSecretId } from "./AppRoleSecretId.ts";
import type { DeleteSecretRequest } from "./DeleteSecret.ts";
import type { Instance } from "./Instance.ts";
import type { ListSecretsRequest } from "./ListSecrets.ts";
import type { ReadSecretClient } from "./ReadSecret.ts";
import type { ReadWriteSecretClient } from "./ReadWriteSecret.ts";
import type { WriteSecretClient } from "./WriteSecret.ts";

/**
 * Shared HTTP scaffolding for Secrets Manager bindings.
 * NOT exported from index.ts.
 *
 * Two APIs, two kinds of access:
 *
 * - The management API takes a STACKIT identity, through `StackitBindings`. Its
 *   reads grant a custom role with `secrets-manager.instance.get`, the permission
 *   the spec names for them (`x-stackit-authorization`), on the project holding
 *   the instance. STACKIT binds roles on nothing narrower.
 * - The secrets themselves are behind the instance's Vault API, which takes no
 *   STACKIT identity. These bindings create an `AppRole` and `AppRoleSecretId` per
 *   host, instance and access level, and put the login in the host's env through
 *   `RuntimeContext`, on any host. They deliberately skip `StackitBindings.Bind`:
 *   it would also create a service account and key the host has no use for.
 */

/** What a management read needs on the project holding the instance. */
const INSTANCE_READ_ACCESS: StackitBindings.Access = {
  permissions: ["secrets-manager.instance.get"],
};

/** Build a management read on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.SecretsManager.GetInstance`. */
  tag: string;
  /** The distilled operation; the instance's project and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      instanceId: instance.instanceId,
    }),
    grants: (instance) => [StackitBindings.grantOn(instance, INSTANCE_READ_ACCESS)],
  });

/** The host env var holding one half of a Vault login. */
const vaultEnvKey = (instance: ResourceLike, write: boolean, part: "ROLE_ID" | "SECRET_ID") =>
  sanitizeKey(`ALCHEMY_STACKIT_VAULT_${instance.LogicalId}_${write ? "WRITE" : "READ"}_${part}`);

/**
 * Create a host's Vault login at deploy, and bind it into the host's env. Bindings
 * sharing a host, instance and access level share one AppRole. With no host (a
 * script), nothing is created. In a host bundle it is a no-op, so the AppRole
 * resources drop out.
 */
const BindVaultLogin: Effect.Effect<(instance: Instance, write: boolean) => Effect.Effect<void>> =
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return () => Effect.void;
    const VaultAppRole = yield* AppRole;
    const VaultSecretId = yield* AppRoleSecretId;
    return Effect.fn(function* (instance: Instance, write: boolean) {
      const host = yield* Binding.Host;
      if (host === undefined) return;
      const logicalId = `${host.LogicalId}${instance.LogicalId}Vault${write ? "Writer" : "Reader"}`;
      const role = yield* VaultAppRole(logicalId, {
        instanceId: instance.instanceId,
        projectId: instance.projectId,
        write,
      });
      const secretId = yield* VaultSecretId(`${logicalId}SecretId`, {
        instanceId: instance.instanceId,
        projectId: instance.projectId,
        roleId: role.roleId,
      });
      const runtime = (yield* CurrentRuntimeContext)!;
      yield* runtime.set(vaultEnvKey(instance, write, "ROLE_ID"), role.roleId);
      yield* runtime.set(vaultEnvKey(instance, write, "SECRET_ID"), secretId.secretId);
    });
  });

/**
 * The host's Vault credentials for a bound instance. Its token cache lives in the
 * returned value, built on the first call, because the instance's URL is only
 * readable once the host runs. With no login in the env (a script), each call
 * fails with `ConfigError`.
 */
const hostVaultCredentials = Effect.fn(function* (
  instance: Instance,
  write: boolean,
  apiUrl: Effect.Effect<string>,
) {
  const runtime = yield* CurrentRuntimeContext;
  const running = globalThis.__ALCHEMY_RUNTIME__ && runtime !== undefined;
  const roleId = running
    ? yield* runtime.get<string>(vaultEnvKey(instance, write, "ROLE_ID"))
    : undefined;
  const secretId = running
    ? yield* runtime.get<string | Redacted.Redacted<string>>(
        vaultEnvKey(instance, write, "SECRET_ID"),
      )
    : undefined;
  if (roleId === undefined || secretId === undefined) {
    return Effect.fail(
      new ConfigError({
        message: `No Vault login is bound for STACKIT Secrets Manager instance ${instance.LogicalId}: secret bindings only run inside a host.`,
      }),
    );
  }
  let cached: ReturnType<typeof appRoleVaultCredentials> | undefined;
  return Effect.suspend(() => {
    if (cached !== undefined) return cached;
    return Effect.flatMap(apiUrl, (url) => {
      cached = appRoleVaultCredentials({
        apiUrl: url,
        roleId,
        // A host's env can hand a secret back unwrapped, whatever its type says.
        secretId: Redacted.isRedacted(secretId) ? secretId : Redacted.make(secretId),
      });
      return cached;
    });
  }).pipe(Effect.provide(FetchHttpClient.layer));
});

/** Calls Vault operations on a bound instance, with its mount and login. */
export interface VaultCaller {
  <I extends { mount: string }, A, E>(
    operation: (input: I) => Effect.Effect<A, E, kv.VaultOpContext>,
    request: Omit<I, "mount">,
  ): Effect.Effect<A, E>;
}

/**
 * Build a binding whose client calls Vault with the host's login: one AppRole for
 * the access level, then the client for the bound instance.
 */
export const makeVaultClientBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.SecretsManager.ReadSecret`. */
  tag: string;
  /** Whether the AppRole needs write access. */
  write: boolean;
  /** Build the client from the caller for the bound instance. */
  makeClient: (call: VaultCaller, tag: string) => Client;
}) =>
  Effect.gen(function* () {
    const bindLogin = yield* BindVaultLogin;
    return Effect.fn(function* (instance: Instance) {
      const mount = yield* instance.instanceId;
      const apiUrl = yield* instance.apiUrl;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bindLogin(instance, options.write);
      }
      const credentials = yield* hostVaultCredentials(instance, options.write, apiUrl);
      const call: VaultCaller = (operation, request) =>
        Effect.gen(function* () {
          const instanceId = yield* mount;
          // The compiler can't prove `Omit<I, "mount">` plus `mount` is `I`.
          const input = { ...request, mount: instanceId } as unknown as Parameters<
            typeof operation
          >[0];
          return yield* operation(input).pipe(
            Effect.provideService(VaultCredentials, credentials),
            Effect.provide(FetchHttpClient.layer),
          );
        });
      return options.makeClient(call, `${options.tag}(${instance.LogicalId})`);
    });
  });

/** Build a binding over one Vault operation: `<Op>Http.ts` is one call to it. */
export const makeVaultOperationBinding = <I extends { mount: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.SecretsManager.GetSecret`. */
  tag: string;
  /** Whether the AppRole needs write access. */
  write: boolean;
  /** The distilled operation; the instance's mount is injected. */
  operation: (input: I) => Effect.Effect<A, E, kv.VaultOpContext>;
}) =>
  makeVaultClientBinding({
    tag: options.tag,
    write: options.write,
    makeClient: (call, tag) =>
      Effect.fn(tag)(function* (request: Omit<I, "mount">) {
        return yield* call(options.operation, request);
      }),
  });

/** {@link kv.listSecrets} and {@link kv.listRootSecrets} as one call. */
const listSecrets = (
  call: VaultCaller,
  secretPath: string | undefined,
): Effect.Effect<kv.ListSecretsResponse, kv.ListSecretsError> =>
  secretPath === undefined || secretPath === ""
    ? call(kv.listRootSecrets, { list: "true" })
    : call(kv.listSecrets, { secretPath, list: "true" });

/** Soft-delete the given versions, or the latest with none given. */
const deleteSecret = (
  call: VaultCaller,
  request: DeleteSecretRequest,
): Effect.Effect<
  kv.DeleteSecretVersionsResponse,
  kv.DeleteSecretVersionsError | kv.DeleteLatestSecretVersionError
> =>
  request.versions === undefined
    ? call(kv.deleteLatestSecretVersion, { secretPath: request.secretPath })
    : call(kv.deleteSecretVersions, {
        secretPath: request.secretPath,
        versions: request.versions,
      });

export const makeListSecretsClient = (call: VaultCaller, tag: string) =>
  Effect.fn(tag)(function* (request?: ListSecretsRequest) {
    return yield* listSecrets(call, request?.secretPath);
  });

export const makeDeleteSecretClient = (call: VaultCaller, tag: string) =>
  Effect.fn(tag)(function* (request: {
    readonly secretPath: string;
    readonly versions?: number[];
  }) {
    return yield* deleteSecret(call, request);
  });

/** Build the read client for an instance's secrets. */
export const makeReadSecretClient = (call: VaultCaller): ReadSecretClient => ({
  get: (request) => call(kv.getSecret, request),
  list: (request) => listSecrets(call, request?.secretPath),
  getMetadata: (request) => call(kv.getSecretMetadata, request),
});

/** Build the write client for an instance's secrets. */
export const makeWriteSecretClient = (call: VaultCaller): WriteSecretClient => ({
  put: (request) => call(kv.putSecret, request),
  delete: (request) => deleteSecret(call, request),
  undelete: (request) => call(kv.undeleteSecretVersions, request),
  destroyVersions: (request) => call(kv.destroySecretVersions, request),
  purge: (request) => call(kv.deleteSecretMetadata, request),
  putMetadata: (request) => call(kv.putSecretMetadata, request),
});

/** Build the client with every operation on an instance's secrets. */
export const makeReadWriteSecretClient = (call: VaultCaller): ReadWriteSecretClient => ({
  ...makeReadSecretClient(call),
  ...makeWriteSecretClient(call),
});
