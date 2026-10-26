import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/** Value of {@link ReadTarget}. */
export const READ_VALUE = "kv-read-value";
/** Initial value of {@link WriteTarget}. */
export const WRITE_VALUE = "kv-write-initial";
/** Value of {@link DoomedTarget}, restored from its backup at the end. */
export const DOOMED_VALUE = "kv-doomed-value";

export const Vault = Azure.KeyVault.Vault("KvSecretsVault", { softDeleteRetentionInDays: 7 });

const secret = (id: string, value: string) =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    return yield* Azure.KeyVault.Secret(id, {
      vault: vault.vaultName,
      value: Redacted.make(value),
    });
  });

/** Read by `GetSecret`, `GetSecretVersions`, and `SecretRead`. */
export const ReadTarget = secret("KvReadTarget", READ_VALUE);
/** Written by `SetSecret`, `UpdateSecret`, `SecretWrite`, and `SecretReadWrite`. */
export const WriteTarget = secret("KvWriteTarget", WRITE_VALUE);
/** Backed up, deleted, recovered, purged, and restored. */
export const DoomedTarget = secret("KvDoomedTarget", DOOMED_VALUE);

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** The `_tag` an effect fails with (`"none"` when it succeeds). */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("none"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/** A secret member as `{ redacted: value }`, so the test sees the binding returned it `Redacted`. */
const exposeRedacted = (value: string | Redacted.Redacted<string> | undefined) =>
  Redacted.isRedacted(value) ? { redacted: Redacted.value(value) } : value;

const versionOf = (id: string | undefined) => id?.split("/").pop();
const nameOf = (id: string | undefined) => id?.split("/secrets/")[1]?.split("/")[0];

/**
 * Effect-native Azure Function exercising every Key Vault secret binding
 * on a managed-identity host, one route per binding. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and role propagation, and a real failure shows the Azure
 * error.
 */
export default class KvSecretsFunction extends Azure.Functions.Function<KvSecretsFunction>()(
  "KvSecretsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const vault = yield* Vault;
    const readTarget = yield* ReadTarget;
    const writeTarget = yield* WriteTarget;
    const doomedTarget = yield* DoomedTarget;

    const getSecret = yield* Azure.KeyVault.GetSecret(readTarget);
    const getVersions = yield* Azure.KeyVault.GetSecretVersions(readTarget);
    const read = yield* Azure.KeyVault.SecretRead(readTarget);

    const setSecret = yield* Azure.KeyVault.SetSecret(writeTarget);
    const updateSecret = yield* Azure.KeyVault.UpdateSecret(writeTarget);
    const write = yield* Azure.KeyVault.SecretWrite(writeTarget);
    const readWrite = yield* Azure.KeyVault.SecretReadWrite(writeTarget);

    const backupSecret = yield* Azure.KeyVault.BackupSecret(doomedTarget);
    const deleteSecret = yield* Azure.KeyVault.DeleteSecret(doomedTarget);
    const getDeleted = yield* Azure.KeyVault.GetDeletedSecret(doomedTarget);
    const recover = yield* Azure.KeyVault.RecoverDeletedSecret(doomedTarget);
    const purge = yield* Azure.KeyVault.PurgeDeletedSecret(doomedTarget);

    const listSecrets = yield* Azure.KeyVault.GetSecrets(vault);
    const listDeleted = yield* Azure.KeyVault.GetDeletedSecrets(vault);
    const restore = yield* Azure.KeyVault.RestoreSecret(vault);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const value = url.searchParams.get("value") ?? "";
        const version = url.searchParams.get("version") ?? "";
        switch (url.pathname) {
          case "/get":
            return yield* respond(
              Effect.gen(function* () {
                const latest = yield* getSecret();
                const pinned = yield* getSecret({ secretVersion: versionOf(latest.id) });
                // Ask for a version that does not exist once access works.
                const missing = yield* failureTag(getSecret({ secretVersion: "0".repeat(32) }));
                return {
                  value: exposeRedacted(latest.value),
                  pinned: exposeRedacted(pinned.value),
                  missing,
                };
              }),
            );
          case "/versions":
            return yield* respond(
              Effect.map(getVersions({ maxresults: 25 }), (page) => ({
                versions: page.value.map((item) => versionOf(item.id)),
              })),
            );
          case "/read":
            return yield* respond(
              Effect.gen(function* () {
                const latest = yield* read.get();
                const versions = yield* read.versions();
                const pinned = yield* read.get(versions[0]?.version);
                return {
                  value: Redacted.value(latest),
                  pinned: Redacted.value(pinned),
                  versions: versions.map((v) => v.version),
                };
              }),
            );

          case "/set":
            return yield* respond(
              Effect.map(setSecret({ value, contentType: "text/plain" }), (bundle) => ({
                version: versionOf(bundle.id),
                contentType: bundle.contentType,
              })),
            );
          case "/update":
            return yield* respond(
              Effect.map(
                updateSecret({
                  secretVersion: version,
                  contentType: "application/json",
                  tags: { updatedBy: "UpdateSecret" },
                }),
                (bundle) => ({ version: versionOf(bundle.id), contentType: bundle.contentType }),
              ),
            );
          case "/write":
            return yield* respond(
              Effect.gen(function* () {
                const written = yield* write.set(Redacted.make(value), { tags: { via: "write" } });
                const updated = yield* write.update(written.version ?? "", {
                  contentType: "text/csv",
                  tags: { via: "write", updated: "yes" },
                });
                return { version: written.version, updatedVersion: updated.version };
              }),
            );
          case "/read-write":
            return yield* respond(
              Effect.gen(function* () {
                const written = yield* readWrite.set(value);
                const back = yield* readWrite.get(written.version);
                const versions = yield* readWrite.versions();
                return {
                  version: written.version,
                  value: Redacted.value(back),
                  listed: versions.some((v) => v.version === written.version),
                };
              }),
            );

          case "/backup":
            return yield* respond(Effect.map(backupSecret(), (backup) => ({ blob: backup.value })));
          case "/delete":
            return yield* respond(
              Effect.map(deleteSecret(), (deleted) => ({
                recoveryId: deleted.recoveryId,
                scheduledPurgeDate: deleted.scheduledPurgeDate,
              })),
            );
          case "/deleted":
            return yield* respond(
              Effect.map(getDeleted(), (deleted) => ({
                name: nameOf(deleted.recoveryId?.replace("/deletedsecrets/", "/secrets/")),
                recoveryId: deleted.recoveryId,
              })),
            );
          case "/recover":
            return yield* respond(Effect.map(recover(), (bundle) => ({ name: nameOf(bundle.id) })));
          case "/purge":
            return yield* respond(
              Effect.gen(function* () {
                yield* purge();
                const after = yield* failureTag(getDeleted());
                return { after };
              }),
            );

          case "/list":
            return yield* respond(
              Effect.map(listSecrets({ maxresults: 25 }), (page) => ({
                names: page.value.map((item) => nameOf(item.id)),
              })),
            );
          case "/deleted-list":
            return yield* respond(
              Effect.map(listDeleted(), (page) => ({
                names: page.value.map((item) =>
                  nameOf(item.recoveryId?.replace("/deletedsecrets/", "/secrets/")),
                ),
              })),
            );
          case "/restore":
            return yield* respond(
              Effect.gen(function* () {
                const blob = yield* request.text;
                const bundle = yield* restore({ value: blob });
                return { name: nameOf(bundle.id) };
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.KeyVault.GetSecretHttp,
        Azure.KeyVault.GetSecretVersionsHttp,
        Azure.KeyVault.SecretReadHttp,
        Azure.KeyVault.SetSecretHttp,
        Azure.KeyVault.UpdateSecretHttp,
        Azure.KeyVault.SecretWriteHttp,
        Azure.KeyVault.SecretReadWriteHttp,
        Azure.KeyVault.BackupSecretHttp,
        Azure.KeyVault.DeleteSecretHttp,
        Azure.KeyVault.GetDeletedSecretHttp,
        Azure.KeyVault.RecoverDeletedSecretHttp,
        Azure.KeyVault.PurgeDeletedSecretHttp,
        Azure.KeyVault.GetSecretsHttp,
        Azure.KeyVault.GetDeletedSecretsHttp,
        Azure.KeyVault.RestoreSecretHttp,
      ),
    ),
  ),
) {}
