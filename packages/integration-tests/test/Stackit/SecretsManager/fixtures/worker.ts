import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** A Worker has no stable egress address, so only the widest range lets it in. */
export const Vault = Stackit.SecretsManager.Instance("SmBindingsInstance", {
  acls: ["0.0.0.0/0"],
});

export const SeedUser = Effect.gen(function* () {
  const vault = yield* Vault;
  return yield* Stackit.SecretsManager.User("SmBindingsUser", {
    instanceId: vault.instanceId,
    description: "bindings suite seed",
  });
});

export const SeedRole = Effect.gen(function* () {
  const vault = yield* Vault;
  return yield* Stackit.SecretsManager.AppRole("SmBindingsRole", {
    instanceId: vault.instanceId,
    description: "bindings suite seed",
  });
});

export const SeedSecretId = Effect.gen(function* () {
  const vault = yield* Vault;
  const role = yield* SeedRole;
  return yield* Stackit.SecretsManager.AppRoleSecretId("SmBindingsSecretId", {
    instanceId: vault.instanceId,
    roleId: role.roleId,
    description: "bindings suite seed",
  });
});

/** `Redacted` serializes as `<redacted>`, so a route that shows a value unwraps it. */
const plainValues = (data: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

const versionsOf = (text: string) => text.split(",").map(Number);

/**
 * A Cloudflare Worker with every Secrets Manager binding. One route per binding;
 * each answers `{ ok, result | error }` so a failure surfaces the error in the test.
 */
export default class SecretsManagerBindingsWorker extends Cloudflare.Worker<SecretsManagerBindingsWorker>()(
  "StackitSecretsManagerBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const vault = yield* Vault;
    const getInstance = yield* Stackit.SecretsManager.GetInstance(vault);
    const listACLs = yield* Stackit.SecretsManager.ListACLs(vault);
    const listUsers = yield* Stackit.SecretsManager.ListUsers(vault);
    const getUser = yield* Stackit.SecretsManager.GetUser(vault);
    const listAppRoles = yield* Stackit.SecretsManager.ListAppRoles(vault);
    const getAppRole = yield* Stackit.SecretsManager.GetAppRole(vault);
    const listAppRoleSecretIds = yield* Stackit.SecretsManager.ListAppRoleSecretIds(vault);
    const getAppRoleSecretId = yield* Stackit.SecretsManager.GetAppRoleSecretId(vault);
    const getSecret = yield* Stackit.SecretsManager.GetSecret(vault);
    const putSecret = yield* Stackit.SecretsManager.PutSecret(vault);
    const listSecrets = yield* Stackit.SecretsManager.ListSecrets(vault);
    const deleteSecret = yield* Stackit.SecretsManager.DeleteSecret(vault);
    const purgeSecret = yield* Stackit.SecretsManager.PurgeSecret(vault);
    const undeleteSecret = yield* Stackit.SecretsManager.UndeleteSecret(vault);
    const destroyVersions = yield* Stackit.SecretsManager.DestroySecretVersions(vault);
    const getMetadata = yield* Stackit.SecretsManager.GetSecretMetadata(vault);
    const putMetadata = yield* Stackit.SecretsManager.PutSecretMetadata(vault);
    const readSecret = yield* Stackit.SecretsManager.ReadSecret(vault);
    const writeSecret = yield* Stackit.SecretsManager.WriteSecret(vault);
    const readWriteSecret = yield* Stackit.SecretsManager.ReadWriteSecret(vault);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        const secretPath = param("path");
        const data = { value: Redacted.make(param("value")) };
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(getInstance({}));
          case "/list-acls":
            return yield* respond(listACLs({}));
          case "/list-users":
            return yield* respond(
              listUsers({}).pipe(Effect.map(({ users }) => users.map((user) => ({ id: user.id })))),
            );
          case "/get-user":
            return yield* respond(
              getUser({ userId: param("id") }).pipe(
                Effect.map((user) => ({ id: user.id, description: user.description })),
              ),
            );
          case "/list-app-roles":
            return yield* respond(listAppRoles({}));
          case "/get-app-role":
            return yield* respond(getAppRole({ roleId: param("id") }));
          case "/list-app-role-secret-ids":
            return yield* respond(
              listAppRoleSecretIds({ roleId: param("id") }).pipe(
                Effect.map(({ secretIds }) => secretIds.map(({ version }) => ({ version }))),
              ),
            );
          case "/get-app-role-secret-id":
            return yield* respond(
              getAppRoleSecretId({
                roleId: param("id"),
                secretIdVersion: Number(param("version")),
              }).pipe(Effect.map(({ version, description }) => ({ version, description }))),
            );
          case "/get-secret":
            return yield* respond(
              getSecret({ secretPath }).pipe(Effect.map(({ data }) => plainValues(data.data))),
            );
          case "/put-secret":
            return yield* respond(putSecret({ secretPath, data }));
          case "/list-secrets":
            return yield* respond(listSecrets({ secretPath }));
          case "/list-root-secrets":
            return yield* respond(listSecrets({}));
          case "/delete-secret":
            return yield* respond(deleteSecret({ secretPath }));
          case "/delete-secret-versions":
            return yield* respond(
              deleteSecret({ secretPath, versions: versionsOf(param("versions")) }),
            );
          case "/purge-secret":
            return yield* respond(purgeSecret({ secretPath }));
          case "/undelete-secret":
            return yield* respond(
              undeleteSecret({ secretPath, versions: versionsOf(param("versions")) }),
            );
          case "/destroy-secret-versions":
            return yield* respond(
              destroyVersions({ secretPath, versions: versionsOf(param("versions")) }),
            );
          case "/get-secret-metadata":
            return yield* respond(getMetadata({ secretPath }));
          case "/put-secret-metadata":
            return yield* respond(putMetadata({ secretPath, max_versions: Number(param("max")) }));
          case "/read-secret":
            return yield* respond(
              Effect.all({
                values: readSecret
                  .get({ secretPath })
                  .pipe(Effect.map(({ data }) => plainValues(data.data))),
                listed: readSecret.list({}),
                metadata: readSecret.getMetadata({ secretPath }),
              }),
            );
          case "/write-secret":
            return yield* respond(writeSecret.put({ secretPath, data }));
          case "/read-write-secret":
            return yield* respond(
              Effect.gen(function* () {
                const written = yield* readWriteSecret.put({ secretPath, data });
                const read = yield* readWriteSecret.get({ secretPath });
                return {
                  version: written.data.version,
                  values: plainValues(read.data.data),
                };
              }),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.SecretsManager.GetInstanceHttp,
        Stackit.SecretsManager.ListACLsHttp,
        Stackit.SecretsManager.ListUsersHttp,
        Stackit.SecretsManager.GetUserHttp,
        Stackit.SecretsManager.ListAppRolesHttp,
        Stackit.SecretsManager.GetAppRoleHttp,
        Stackit.SecretsManager.ListAppRoleSecretIdsHttp,
        Stackit.SecretsManager.GetAppRoleSecretIdHttp,
        Stackit.SecretsManager.GetSecretHttp,
        Stackit.SecretsManager.PutSecretHttp,
        Stackit.SecretsManager.ListSecretsHttp,
        Stackit.SecretsManager.DeleteSecretHttp,
        Stackit.SecretsManager.PurgeSecretHttp,
        Stackit.SecretsManager.UndeleteSecretHttp,
        Stackit.SecretsManager.DestroySecretVersionsHttp,
        Stackit.SecretsManager.GetSecretMetadataHttp,
        Stackit.SecretsManager.PutSecretMetadataHttp,
        Stackit.SecretsManager.ReadSecretHttp,
        Stackit.SecretsManager.WriteSecretHttp,
        Stackit.SecretsManager.ReadWriteSecretHttp,
      ),
    ),
  ),
) {}
