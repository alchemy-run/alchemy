import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

export const Vault = Azure.KeyVault.Vault("KvKeysVault", { softDeleteRetentionInDays: 7 });

const key = (id: string, props: Omit<Azure.KeyVault.KeyProps, "vault" | "resourceGroup"> = {}) =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    return yield* Azure.KeyVault.Key(id, { ...props, vault: vault.vaultName });
  });

/** Read-only: `GetKey`, `GetKeyVersions`, `GetKeyRotationPolicy`, `ReleaseKey`, `KeyRead`. */
export const ReadKey = key("KvReadKey", {
  rotationPolicy: {
    expiryTime: "P1Y",
    lifetimeActions: [{ action: "rotate", timeAfterCreate: "P90D" }],
  },
});
/** New versions and attributes: `CreateKey`, `RotateKey`, `UpdateKey`, `UpdateKeyRotationPolicy`, `KeyWrite`, `KeyReadWrite`. */
export const MutableKey = key("KvMutableKey");
/** Imported material: `ImportKey` and the cryptographic operations. */
export const CryptoKey = key("KvCryptoKey");
/** Deleted and recovered: `DeleteKey`, `GetDeletedKey`, `RecoverDeletedKey`. */
export const RecoverableKey = key("KvRecoverableKey");
/** Backed up, deleted, purged, and restored: `BackupKey`, `DeleteKey`, `PurgeDeletedKey`, `RestoreKey`. */
export const PurgedKey = key("KvPurgedKey");

type Failure = { readonly _tag: string; readonly message?: string };
type Route = (body: unknown) => Effect.Effect<unknown, Failure, RuntimeContext>;

/** Expose a binding callable as a route taking its request as the JSON body. */
const route =
  <R>(call: (request: R) => Effect.Effect<unknown, Failure, RuntimeContext>): Route =>
  (body) =>
    call(body as R);

/**
 * Answer `{ ok: true, result }`, or `{ ok: false, tag, error }` with a 500
 * so callers retry through role propagation and assert typed failures.
 */
const respond = (effect: Effect.Effect<unknown, Failure, RuntimeContext>) =>
  effect.pipe(
    Effect.map((result) => ({ ok: true, result })),
    Effect.catch((error) =>
      Effect.succeed({ ok: false, tag: error._tag, error: error.message ?? error._tag }),
    ),
    Effect.flatMap((body) => HttpServerResponse.json(body, { status: body.ok ? 200 : 500 })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising every Key Vault key binding on a
 * managed-identity host. `POST /call/<route>` calls one binding with the
 * JSON body as its request.
 */
export default class KvKeysFunction extends Azure.Functions.Function<KvKeysFunction>()(
  "KvKeysFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const vault = yield* Vault;
    const readKey = yield* ReadKey;
    const mutableKey = yield* MutableKey;
    const cryptoKey = yield* CryptoKey;
    const recoverableKey = yield* RecoverableKey;
    const purgedKey = yield* PurgedKey;

    const read = yield* Azure.KeyVault.KeyRead(readKey);
    const write = yield* Azure.KeyVault.KeyWrite(mutableKey);
    const readWrite = yield* Azure.KeyVault.KeyReadWrite(mutableKey);

    const getKey = yield* Azure.KeyVault.GetKey(readKey);
    const getKeyVersions = yield* Azure.KeyVault.GetKeyVersions(readKey);
    const getKeyRotationPolicy = yield* Azure.KeyVault.GetKeyRotationPolicy(readKey);
    const releaseKey = yield* Azure.KeyVault.ReleaseKey(readKey);
    const createKey = yield* Azure.KeyVault.CreateKey(mutableKey);
    const rotateKey = yield* Azure.KeyVault.RotateKey(mutableKey);
    const updateKey = yield* Azure.KeyVault.UpdateKey(mutableKey);
    const updateKeyRotationPolicy = yield* Azure.KeyVault.UpdateKeyRotationPolicy(mutableKey);
    const importKey = yield* Azure.KeyVault.ImportKey(cryptoKey);
    const encrypt = yield* Azure.KeyVault.Encrypt(cryptoKey);
    const decrypt = yield* Azure.KeyVault.Decrypt(cryptoKey);
    const wrapKey = yield* Azure.KeyVault.WrapKey(cryptoKey);
    const unwrapKey = yield* Azure.KeyVault.UnwrapKey(cryptoKey);
    const sign = yield* Azure.KeyVault.Sign(cryptoKey);
    const verify = yield* Azure.KeyVault.Verify(cryptoKey);
    const recoverableDeleteKey = yield* Azure.KeyVault.DeleteKey(recoverableKey);
    const recoverableGetDeletedKey = yield* Azure.KeyVault.GetDeletedKey(recoverableKey);
    const recoverDeletedKey = yield* Azure.KeyVault.RecoverDeletedKey(recoverableKey);
    const backupKey = yield* Azure.KeyVault.BackupKey(purgedKey);
    const purgedDeleteKey = yield* Azure.KeyVault.DeleteKey(purgedKey);
    const purgedGetDeletedKey = yield* Azure.KeyVault.GetDeletedKey(purgedKey);
    const purgeDeletedKey = yield* Azure.KeyVault.PurgeDeletedKey(purgedKey);
    const getKeys = yield* Azure.KeyVault.GetKeys(vault);
    const getDeletedKeys = yield* Azure.KeyVault.GetDeletedKeys(vault);
    const restoreKey = yield* Azure.KeyVault.RestoreKey(vault);

    const routes: Record<string, Route> = {
      GetKey: route(getKey),
      GetKeyVersions: route(getKeyVersions),
      GetKeyRotationPolicy: route(getKeyRotationPolicy),
      ReleaseKey: route(releaseKey),

      CreateKey: route(createKey),
      RotateKey: route(rotateKey),
      UpdateKey: route(updateKey),
      UpdateKeyRotationPolicy: route(updateKeyRotationPolicy),

      ImportKey: route(importKey),
      Encrypt: route(encrypt),
      Decrypt: route(decrypt),
      WrapKey: route(wrapKey),
      UnwrapKey: route(unwrapKey),
      Sign: route(sign),
      Verify: route(verify),

      "Recoverable.DeleteKey": route(recoverableDeleteKey),
      "Recoverable.GetDeletedKey": route(recoverableGetDeletedKey),
      RecoverDeletedKey: route(recoverDeletedKey),

      BackupKey: route(backupKey),
      "Purged.DeleteKey": route(purgedDeleteKey),
      "Purged.GetDeletedKey": route(purgedGetDeletedKey),
      PurgeDeletedKey: route(purgeDeletedKey),

      GetKeys: route(getKeys),
      GetDeletedKeys: route(getDeletedKeys),
      RestoreKey: route(restoreKey),

      "KeyRead.get": route((request: { version?: string }) => read.get(request.version)),
      "KeyRead.versions": route(() => read.versions()),
      "KeyRead.rotationPolicy": route(() => read.rotationPolicy()),
      "KeyWrite.rotate": route(() => write.rotate()),
      "KeyReadWrite.createAndGet": route(() =>
        Effect.gen(function* () {
          const created = yield* readWrite.create({ kty: "RSA", key_size: 2048 });
          const version = created.key?.kid?.split("/").pop();
          const back = yield* readWrite.get(version);
          return { created: created.key?.kid, read: back.key?.kid };
        }),
      ),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const name = url.pathname.startsWith("/call/")
          ? decodeURIComponent(url.pathname.slice("/call/".length))
          : "";
        const call = routes[name];
        if (call === undefined) return HttpServerResponse.text("not found", { status: 404 });
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed({})));
        return yield* respond(call(body));
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.KeyVault.GetKeyHttp,
        Azure.KeyVault.GetKeyVersionsHttp,
        Azure.KeyVault.GetKeyRotationPolicyHttp,
        Azure.KeyVault.ReleaseKeyHttp,
        Azure.KeyVault.CreateKeyHttp,
        Azure.KeyVault.RotateKeyHttp,
        Azure.KeyVault.UpdateKeyHttp,
        Azure.KeyVault.UpdateKeyRotationPolicyHttp,
        Azure.KeyVault.ImportKeyHttp,
        Azure.KeyVault.EncryptHttp,
        Azure.KeyVault.DecryptHttp,
        Azure.KeyVault.WrapKeyHttp,
        Azure.KeyVault.UnwrapKeyHttp,
        Azure.KeyVault.SignHttp,
        Azure.KeyVault.VerifyHttp,
        Azure.KeyVault.DeleteKeyHttp,
        Azure.KeyVault.GetDeletedKeyHttp,
        Azure.KeyVault.RecoverDeletedKeyHttp,
        Azure.KeyVault.BackupKeyHttp,
        Azure.KeyVault.PurgeDeletedKeyHttp,
        Azure.KeyVault.GetKeysHttp,
        Azure.KeyVault.GetDeletedKeysHttp,
        Azure.KeyVault.RestoreKeyHttp,
        Azure.KeyVault.KeyReadHttp,
        Azure.KeyVault.KeyWriteHttp,
        Azure.KeyVault.KeyReadWriteHttp,
      ),
    ),
  ),
) {}
