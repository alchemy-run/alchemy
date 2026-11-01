import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import { appRoleVaultCredentials, VaultCredentials } from "@distilled.cloud/stackit/Vault";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";

/**
 * Out-of-band access to an instance's Vault API for the Secrets Manager suites:
 * a throwaway read-and-write AppRole minted through the management API, deleted
 * afterwards. These suites deploy instances with `acls: ["0.0.0.0/0"]`, so both
 * the test process and a Cloudflare Worker can reach Vault.
 */
export const withVault = <A, E, R>(
  instance: { readonly projectId: string; readonly instanceId: string; readonly apiUrl: string },
  use: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    secretsManager.createApprole({
      projectId: instance.projectId,
      instanceId: instance.instanceId,
      description: "alchemy-test-out-of-band",
      write: true,
    }),
    (role) =>
      Effect.gen(function* () {
        const { secret_id: secretId } = yield* secretsManager.createApproleSecretId({
          projectId: instance.projectId,
          instanceId: instance.instanceId,
          roleId: role.role_id,
        });
        const client = yield* HttpClient.HttpClient;
        const credentials = appRoleVaultCredentials({
          apiUrl: instance.apiUrl,
          roleId: role.role_id,
          secretId: Redacted.isRedacted(secretId) ? secretId : Redacted.make(secretId ?? ""),
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        return yield* use.pipe(Effect.provideService(VaultCredentials, credentials));
      }),
    (role) =>
      secretsManager
        .deleteApprole({
          projectId: instance.projectId,
          instanceId: instance.instanceId,
          roleId: role.role_id,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void)),
  );

/** A secret's current data as plain strings; `"gone"` on the typed `NotFound`. */
export const readSecretValues = (mount: string, secretPath: string) =>
  kv.getSecret({ mount, secretPath }).pipe(
    Effect.map(
      ({ data }) =>
        Object.fromEntries(
          Object.entries(data.data).map(([key, value]) => [
            key,
            Redacted.isRedacted(value) ? Redacted.value(value) : value,
          ]),
        ) as Record<string, string>,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** A secret's metadata; `"gone"` on the typed `NotFound`. */
export const readSecretMetadata = (mount: string, secretPath: string) =>
  kv.getSecretMetadata({ mount, secretPath }).pipe(
    Effect.map(({ data }) => data),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );
