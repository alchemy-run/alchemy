import * as crypto from "node:crypto";
import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import KvKeysFunction, {
  CryptoKey,
  MutableKey,
  PurgedKey,
  ReadKey,
  RecoverableKey,
  Vault,
} from "./fixtures/key-function.ts";
import { RSA_JWK } from "./fixtures/rsa-jwk.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureKeyVaultKeyBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* KvKeysFunction;
    const vault = yield* Vault;
    const readKey = yield* ReadKey;
    const mutableKey = yield* MutableKey;
    const cryptoKey = yield* CryptoKey;
    const recoverableKey = yield* RecoverableKey;
    const purgedKey = yield* PurgedKey;
    return {
      url: fn.url,
      principalId: fn.principalId,
      resourceGroup: vault.resourceGroup,
      vaultName: vault.vaultName,
      vaultId: vault.vaultId,
      readKey: { name: readKey.keyName, id: readKey.keyId },
      mutableKey: { name: mutableKey.keyName, id: mutableKey.keyId },
      cryptoKey: { name: cryptoKey.keyName, id: cryptoKey.keyId },
      recoverableKey: { name: recoverableKey.keyName, id: recoverableKey.keyId },
      purgedKey: { name: purgedKey.keyName, id: purgedKey.keyId },
    };
  }),
);

// ~$0.01/run (standard vault, software keys at $0.03 per 10k operations, Flex
// Consumption function); ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; tag?: string; error?: string };

/**
 * POST `/call/<route>` until the answer satisfies `until` (by default: it
 * succeeded), through the Flex Consumption cold start and role
 * propagation (about 4 minutes), then return the last answer so a real
 * failure shows its Azure error.
 */
const call = (route: string, body: unknown = {}, until: (body: Body) => boolean = (b) => b.ok) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(
      HttpClientRequest.post(`${url}/call/${route}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    ).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((answer) => (until(answer) ? Effect.succeed(answer) : Effect.fail(answer))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((answer) => Effect.succeed(answer as Body)),
    );
  });

const expectOk = (body: Body) =>
  expect({ ok: body.ok, tag: body.tag, error: body.error }).toEqual({
    ok: true,
    tag: undefined,
    error: undefined,
  });

const versionOf = (kid: string | undefined) => kid?.split("/").pop() ?? "";

/** The key as Azure Resource Manager sees it (deployer credentials). */
const armKey = (keyName: string) =>
  Effect.gen(function* () {
    const { resourceGroup, vaultName } = yield* stack;
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault.GetKey({
      subscriptionId,
      resourceGroupName: resourceGroup,
      vaultName,
      keyName,
    });
  }).pipe(Effect.provide(azure));

/** One version of the key as Azure Resource Manager sees it. */
const armKeyVersion = (keyName: string, keyVersion: string) =>
  Effect.gen(function* () {
    const { resourceGroup, vaultName } = yield* stack;
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault
      .GetKeyVersion({
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName,
        keyName,
        keyVersion,
      })
      .pipe(
        // A version written through the data plane reaches ARM within seconds.
        Effect.retry({
          while: (e) => e._tag === "ResourceNotFound" || e._tag === "NotFound",
          schedule: Schedule.spaced("3 seconds"),
          times: 10,
        }),
      );
  }).pipe(Effect.provide(azure));

/** Whether ARM finds the key, polled until it reports `want`. */
const armPresence = (keyName: string, want: "found" | "gone") =>
  armKey(keyName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "NotFound"], () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === want,
      times: 24,
    }),
  );

const privateKey = Effect.sync(() => crypto.createPrivateKey({ key: RSA_JWK, format: "jwk" }));
const publicKey = Effect.sync(() =>
  crypto.createPublicKey({ key: { kty: RSA_JWK.kty, n: RSA_JWK.n, e: RSA_JWK.e }, format: "jwk" }),
);
const OAEP_256 = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" };
const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

/** Import {@link RSA_JWK} as a new version of the crypto key; returns its version. */
const importVersion = Effect.gen(function* () {
  const body = yield* call("ImportKey", { key: RSA_JWK });
  expectOk(body);
  return versionOf(body.result.key.kid);
});

describe("Azure Key Vault key bindings", { tags: ["provider:azure", "live"] }, () => {
  describe("GetKey", () => {
    test(
      "reads the latest and a pinned version of the key",
      Effect.gen(function* () {
        const { readKey } = yield* stack;
        const latest = yield* call("GetKey");
        expectOk(latest);
        const observed = yield* armKey(readKey.name);
        expect(latest.result.key.kid).toEqual(observed.properties.keyUriWithVersion);
        expect(latest.result.key.kty).toEqual("RSA");
        expect(Buffer.from(latest.result.key.n, "base64url").byteLength).toEqual(256);
        const pinned = yield* call("GetKey", { keyVersion: versionOf(latest.result.key.kid) });
        expectOk(pinned);
        expect(pinned.result.key.kid).toEqual(latest.result.key.kid);
      }),
      { timeout: 300_000 },
    );
  });

  describe("GetKeyVersions", () => {
    test(
      "lists the versions of the key",
      Effect.gen(function* () {
        const { readKey } = yield* stack;
        const body = yield* call("GetKeyVersions", { maxresults: 25 });
        expectOk(body);
        const observed = yield* armKey(readKey.name);
        expect(body.result.value.map((v: { kid: string }) => v.kid)).toEqual([
          observed.properties.keyUriWithVersion,
        ]);
      }),
      { timeout: 300_000 },
    );
  });

  describe("GetKeyRotationPolicy", () => {
    test(
      "reads the rotation policy set through ARM",
      Effect.gen(function* () {
        const { readKey } = yield* stack;
        const body = yield* call("GetKeyRotationPolicy");
        expectOk(body);
        const observed = yield* armKey(readKey.name);
        expect(body.result.attributes.expiryTime).toEqual(
          observed.properties.rotationPolicy?.attributes?.expiryTime,
        );
        const rotate = body.result.lifetimeActions.find(
          (a: { action: { type: string } }) => a.action.type.toLowerCase() === "rotate",
        );
        expect(rotate.trigger.timeAfterCreate).toEqual("P90D");
      }),
      { timeout: 300_000 },
    );
  });

  // Secure key release needs an exportable key with a release policy and an
  // attestation token from a confidential VM or container (an external
  // system); this probe pins the typed rejection of an unattested caller.
  describe("ReleaseKey", () => {
    test(
      "rejects a target that is not an attestation token",
      Effect.gen(function* () {
        const body = yield* call(
          "ReleaseKey",
          { target: "eyJhbGciOiJub25lIn0.e30." },
          (b) => b.tag === "KeyReleaseAttestationRejected",
        );
        expect(body.tag).toEqual("KeyReleaseAttestationRejected");
      }),
      { timeout: 300_000 },
    );
  });

  describe("KeyRead", () => {
    test(
      "gets the key, its versions, and its rotation policy",
      Effect.gen(function* () {
        const { readKey } = yield* stack;
        const observed = yield* armKey(readKey.name);
        const got = yield* call("KeyRead.get");
        expectOk(got);
        expect(got.result.key.kid).toEqual(observed.properties.keyUriWithVersion);
        const versions = yield* call("KeyRead.versions");
        expectOk(versions);
        expect(versions.result.value.map((v: { kid: string }) => v.kid)).toEqual([
          observed.properties.keyUriWithVersion,
        ]);
        const policy = yield* call("KeyRead.rotationPolicy");
        expectOk(policy);
        expect(policy.result.attributes.expiryTime).toEqual("P1Y");
      }),
      { timeout: 300_000 },
    );
  });

  describe("CreateKey", () => {
    test(
      "creates a new version with the requested size",
      Effect.gen(function* () {
        const { mutableKey } = yield* stack;
        const body = yield* call("CreateKey", { kty: "RSA", key_size: 3072 });
        expectOk(body);
        const version = yield* armKeyVersion(mutableKey.name, versionOf(body.result.key.kid));
        expect(version.properties.keyUriWithVersion).toEqual(body.result.key.kid);
        expect(version.properties.keySize).toEqual(3072);
      }),
      { timeout: 300_000 },
    );
  });

  describe("RotateKey", () => {
    test(
      "rotates the key into a new version",
      Effect.gen(function* () {
        const { mutableKey } = yield* stack;
        const before = yield* armKey(mutableKey.name);
        const body = yield* call("RotateKey");
        expectOk(body);
        expect(body.result.key.kid).not.toEqual(before.properties.keyUriWithVersion);
        const version = yield* armKeyVersion(mutableKey.name, versionOf(body.result.key.kid));
        expect(version.properties.keyUriWithVersion).toEqual(body.result.key.kid);
      }),
      { timeout: 300_000 },
    );
  });

  describe("UpdateKey", () => {
    test(
      "sets an expiry on one version",
      Effect.gen(function* () {
        const { mutableKey } = yield* stack;
        const before = yield* armKey(mutableKey.name);
        const keyVersion = versionOf(before.properties.keyUriWithVersion);
        // 2100-01-01T00:00:00Z
        const exp = 4_102_444_800;
        const body = yield* call("UpdateKey", { keyVersion, attributes: { exp } });
        expectOk(body);
        const version = yield* armKeyVersion(mutableKey.name, keyVersion).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (v) => v.properties.attributes?.exp === exp,
            times: 10,
          }),
        );
        expect(version.properties.attributes?.exp).toEqual(exp);
      }),
      { timeout: 300_000 },
    );
  });

  describe("UpdateKeyRotationPolicy", () => {
    test(
      "replaces the rotation policy",
      Effect.gen(function* () {
        const { mutableKey } = yield* stack;
        const body = yield* call("UpdateKeyRotationPolicy", {
          attributes: { expiryTime: "P2Y" },
          lifetimeActions: [{ action: { type: "Rotate" }, trigger: { timeAfterCreate: "P180D" } }],
        });
        expectOk(body);
        const observed = yield* armKey(mutableKey.name).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (k) => k.properties.rotationPolicy?.attributes?.expiryTime === "P2Y",
            times: 10,
          }),
        );
        expect(observed.properties.rotationPolicy?.attributes?.expiryTime).toEqual("P2Y");
        // Key Vault adds its default notify action next to the rotate action.
        const rotate = observed.properties.rotationPolicy?.lifetimeActions?.filter(
          (a) => a.action?.type?.toLowerCase() === "rotate",
        );
        expect(rotate?.map((a) => a.trigger?.timeAfterCreate)).toEqual(["P180D"]);
      }),
      { timeout: 300_000 },
    );
  });

  describe("KeyWrite", () => {
    test(
      "rotates the key",
      Effect.gen(function* () {
        const { mutableKey } = yield* stack;
        const body = yield* call("KeyWrite.rotate");
        expectOk(body);
        const version = yield* armKeyVersion(mutableKey.name, versionOf(body.result.key.kid));
        expect(version.properties.keyUriWithVersion).toEqual(body.result.key.kid);
      }),
      { timeout: 300_000 },
    );
  });

  describe("KeyReadWrite", () => {
    test(
      "creates a version and reads it back",
      Effect.gen(function* () {
        const { mutableKey } = yield* stack;
        const body = yield* call("KeyReadWrite.createAndGet");
        expectOk(body);
        expect(body.result.read).toEqual(body.result.created);
        const version = yield* armKeyVersion(mutableKey.name, versionOf(body.result.created));
        expect(version.properties.keyUriWithVersion).toEqual(body.result.created);
      }),
      { timeout: 300_000 },
    );
  });

  describe("ImportKey", () => {
    test(
      "imports external key material as a new version",
      Effect.gen(function* () {
        const { cryptoKey } = yield* stack;
        const body = yield* call("ImportKey", { key: RSA_JWK });
        expectOk(body);
        expect(body.result.key.n).toEqual(RSA_JWK.n);
        const version = yield* armKeyVersion(cryptoKey.name, versionOf(body.result.key.kid));
        expect(version.properties.keyUriWithVersion).toEqual(body.result.key.kid);
        expect(version.properties.kty).toEqual("RSA");
      }),
      { timeout: 300_000 },
    );
  });

  describe("Encrypt", () => {
    test(
      "encrypts data the imported private key decrypts",
      Effect.gen(function* () {
        const keyVersion = yield* importVersion;
        const body = yield* call("Encrypt", {
          keyVersion,
          alg: "RSA-OAEP-256",
          value: b64url("hello from Encrypt"),
        });
        expectOk(body);
        expect(versionOf(body.result.kid)).toEqual(keyVersion);
        const key = yield* privateKey;
        const plain = yield* Effect.sync(() =>
          crypto.privateDecrypt({ key, ...OAEP_256 }, Buffer.from(body.result.value, "base64url")),
        );
        expect(plain.toString()).toEqual("hello from Encrypt");
      }),
      { timeout: 300_000 },
    );
  });

  describe("Decrypt", () => {
    test(
      "decrypts data encrypted with the imported public key",
      Effect.gen(function* () {
        const keyVersion = yield* importVersion;
        const key = yield* publicKey;
        const cipher = yield* Effect.sync(() =>
          crypto.publicEncrypt({ key, ...OAEP_256 }, Buffer.from("hello from Decrypt")),
        );
        const body = yield* call("Decrypt", {
          keyVersion,
          alg: "RSA-OAEP-256",
          value: b64url(cipher),
        });
        expectOk(body);
        expect(Buffer.from(body.result.value, "base64url").toString()).toEqual(
          "hello from Decrypt",
        );
      }),
      { timeout: 300_000 },
    );
  });

  describe("WrapKey", () => {
    test(
      "wraps a symmetric key the imported private key unwraps",
      Effect.gen(function* () {
        const keyVersion = yield* importVersion;
        const dek = yield* Effect.sync(() => crypto.randomBytes(32));
        const body = yield* call("WrapKey", {
          keyVersion,
          alg: "RSA-OAEP-256",
          value: b64url(dek),
        });
        expectOk(body);
        const key = yield* privateKey;
        const unwrapped = yield* Effect.sync(() =>
          crypto.privateDecrypt({ key, ...OAEP_256 }, Buffer.from(body.result.value, "base64url")),
        );
        expect(unwrapped.equals(dek)).toBe(true);
      }),
      { timeout: 300_000 },
    );
  });

  describe("UnwrapKey", () => {
    test(
      "unwraps a symmetric key wrapped with the imported public key",
      Effect.gen(function* () {
        const keyVersion = yield* importVersion;
        const dek = yield* Effect.sync(() => crypto.randomBytes(32));
        const key = yield* publicKey;
        const wrapped = yield* Effect.sync(() => crypto.publicEncrypt({ key, ...OAEP_256 }, dek));
        const body = yield* call("UnwrapKey", {
          keyVersion,
          alg: "RSA-OAEP-256",
          value: b64url(wrapped),
        });
        expectOk(body);
        expect(Buffer.from(body.result.value, "base64url").equals(dek)).toBe(true);
      }),
      { timeout: 300_000 },
    );
  });

  describe("Sign", () => {
    test(
      "signs a digest the imported public key verifies",
      Effect.gen(function* () {
        const keyVersion = yield* importVersion;
        const data = Buffer.from("signed by Sign");
        const digest = yield* Effect.sync(() => crypto.createHash("sha256").update(data).digest());
        const body = yield* call("Sign", { keyVersion, alg: "RS256", value: b64url(digest) });
        expectOk(body);
        const key = yield* publicKey;
        const valid = yield* Effect.sync(() =>
          crypto.verify("sha256", data, key, Buffer.from(body.result.value, "base64url")),
        );
        expect(valid).toBe(true);
      }),
      { timeout: 300_000 },
    );
  });

  describe("Verify", () => {
    test(
      "accepts a signature from the imported private key and rejects a tampered digest",
      Effect.gen(function* () {
        const keyVersion = yield* importVersion;
        const data = Buffer.from("signed for Verify");
        const key = yield* privateKey;
        const signature = yield* Effect.sync(() => crypto.sign("sha256", data, key));
        const digest = yield* Effect.sync(() => crypto.createHash("sha256").update(data).digest());
        const other = yield* Effect.sync(() =>
          crypto.createHash("sha256").update("something else").digest(),
        );
        const valid = yield* call("Verify", {
          keyVersion,
          alg: "RS256",
          digest: b64url(digest),
          value: b64url(signature),
        });
        expectOk(valid);
        expect(valid.result.value).toBe(true);
        const tampered = yield* call("Verify", {
          keyVersion,
          alg: "RS256",
          digest: b64url(other),
          value: b64url(signature),
        });
        expectOk(tampered);
        expect(tampered.result.value).toBe(false);
      }),
      { timeout: 300_000 },
    );
  });

  // Delete, read the deleted key, and recover it, in order.
  describe.sequential("soft delete and recovery", () => {
    describe("DeleteKey", () => {
      test(
        "soft-deletes the key",
        Effect.gen(function* () {
          const { recoverableKey } = yield* stack;
          const body = yield* call("Recoverable.DeleteKey");
          expectOk(body);
          expect(body.result.recoveryId).toContain(`/deletedkeys/${recoverableKey.name}`);
          const presence = yield* armPresence(recoverableKey.name, "gone");
          expect(presence).toEqual("gone");
        }),
        { timeout: 300_000 },
      );
    });

    describe("GetDeletedKey", () => {
      test(
        "reads the soft-deleted key",
        Effect.gen(function* () {
          const { recoverableKey } = yield* stack;
          const body = yield* call("Recoverable.GetDeletedKey");
          expectOk(body);
          expect(body.result.recoveryId).toContain(`/deletedkeys/${recoverableKey.name}`);
          expect(typeof body.result.scheduledPurgeDate).toEqual("number");
        }),
        { timeout: 300_000 },
      );
    });

    describe("RecoverDeletedKey", () => {
      test(
        "recovers the soft-deleted key",
        Effect.gen(function* () {
          const { recoverableKey } = yield* stack;
          const body = yield* call("RecoverDeletedKey");
          expectOk(body);
          expect(body.result.key.kid).toContain(`/keys/${recoverableKey.name}/`);
          const presence = yield* armPresence(recoverableKey.name, "found");
          expect(presence).toEqual("found");
        }),
        { timeout: 300_000 },
      );
    });
  });

  // Back up, delete, list as deleted, purge, and restore, in order.
  describe.sequential("backup, purge, and restore", () => {
    let backup = "";

    describe("BackupKey", () => {
      test(
        "backs up the key",
        Effect.gen(function* () {
          const body = yield* call("BackupKey");
          expectOk(body);
          expect(body.result.value.length).toBeGreaterThan(100);
          backup = body.result.value;
        }),
        { timeout: 300_000 },
      );
    });

    describe("GetDeletedKeys", () => {
      test(
        "lists the key once it is deleted",
        Effect.gen(function* () {
          const { purgedKey } = yield* stack;
          const deleted = yield* call("Purged.DeleteKey");
          expectOk(deleted);
          const presence = yield* armPresence(purgedKey.name, "gone");
          expect(presence).toEqual("gone");
          const body = yield* call(
            "GetDeletedKeys",
            {},
            (b) =>
              b.ok === true &&
              b.result.value.some(
                (k: { recoveryId: string }) => k.recoveryId === deleted.result.recoveryId,
              ),
          );
          expectOk(body);
          expect(body.result.value.map((k: { recoveryId: string }) => k.recoveryId)).toContain(
            deleted.result.recoveryId,
          );
        }),
        { timeout: 300_000 },
      );
    });

    describe("PurgeDeletedKey", () => {
      test(
        "purges the deleted key",
        Effect.gen(function* () {
          // Purging is accepted only once the delete has finished.
          const purged = yield* call("PurgeDeletedKey");
          expectOk(purged);
          const gone = yield* call(
            "Purged.GetDeletedKey",
            {},
            (b) => b.tag === "KeyVaultKeyNotFound",
          );
          expect(gone.tag).toEqual("KeyVaultKeyNotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("RestoreKey", () => {
      test(
        "restores the purged key from its backup",
        Effect.gen(function* () {
          const { purgedKey } = yield* stack;
          expect(backup.length).toBeGreaterThan(100);
          const body = yield* call("RestoreKey", { value: backup });
          expectOk(body);
          expect(body.result.key.kid).toContain(`/keys/${purgedKey.name}/`);
          const presence = yield* armPresence(purgedKey.name, "found");
          expect(presence).toEqual("found");
        }),
        { timeout: 300_000 },
      );
    });
  });

  describe("GetKeys", () => {
    test(
      "lists the keys in the vault",
      Effect.gen(function* () {
        const { readKey } = yield* stack;
        const observed = yield* armKey(readKey.name);
        const body = yield* call("GetKeys", { maxresults: 25 });
        expectOk(body);
        expect(body.result.value.map((k: { kid: string }) => k.kid)).toContain(
          observed.properties.keyUri,
        );
      }),
      { timeout: 300_000 },
    );
  });

  describe("least privilege", () => {
    test(
      "assigns one single-data-action role per operation, on the bound key or vault only",
      Effect.gen(function* () {
        const outputs = yield* stack;
        const { subscriptionId } = yield* Azure.AzureEnvironment.current;
        // Wait for the first binding call: the grants exist by then.
        const first = yield* call("GetKey");
        expectOk(first);
        const page = yield* authorization.ListRoleAssignmentForSubscription({
          subscriptionId,
          _filter: `principalId eq '${outputs.principalId}'`,
        });
        const granted = new Map<string, string[]>();
        for (const assignment of page.value) {
          const scope = assignment.properties?.scope?.toLowerCase() ?? "";
          // The host's own storage roles are not key bindings.
          if (!scope.includes("/providers/microsoft.keyvault/")) continue;
          const roleDefinitionId = assignment.properties?.roleDefinitionId ?? "";
          const definition = yield* authorization.GetRoleDefinition({
            scope: `/subscriptions/${subscriptionId}`,
            roleDefinitionId: roleDefinitionId.split("/").pop() ?? "",
          });
          const permissions = definition.properties?.permissions ?? [];
          expect(permissions.flatMap((p) => p.actions ?? [])).toEqual([]);
          const dataActions = permissions.flatMap((p) => p.dataActions ?? []);
          expect(dataActions.length).toEqual(1);
          granted.set(scope, [...(granted.get(scope) ?? []), ...dataActions].sort());
        }
        const keys = "Microsoft.KeyVault/vaults/keys";
        const policies = "Microsoft.KeyVault/vaults/keyrotationpolicies";
        const of = (id: string) => granted.get(id.toLowerCase());
        expect(of(outputs.readKey.id)).toEqual(
          [`${keys}/read`, `${keys}/release/action`, `${policies}/read`].sort(),
        );
        expect(of(outputs.mutableKey.id)).toEqual(
          [
            `${keys}/create/action`,
            `${keys}/delete`,
            `${keys}/import/action`,
            `${keys}/read`,
            `${keys}/rotate/action`,
            `${keys}/update/action`,
            `${policies}/read`,
            `${policies}/write`,
          ].sort(),
        );
        expect(of(outputs.cryptoKey.id)).toEqual(
          [
            `${keys}/decrypt/action`,
            `${keys}/encrypt/action`,
            `${keys}/import/action`,
            `${keys}/sign/action`,
            `${keys}/unwrap/action`,
            `${keys}/verify/action`,
            `${keys}/wrap/action`,
          ].sort(),
        );
        expect(of(outputs.recoverableKey.id)).toEqual(
          [`${keys}/delete`, `${keys}/read`, `${keys}/recover/action`].sort(),
        );
        expect(of(outputs.purgedKey.id)).toEqual(
          [
            `${keys}/backup/action`,
            `${keys}/delete`,
            `${keys}/purge/action`,
            `${keys}/read`,
          ].sort(),
        );
        expect(of(outputs.vaultId)).toEqual([`${keys}/read`, `${keys}/restore/action`].sort());
      }).pipe(Effect.provide(azure)),
      { timeout: 300_000 },
    );
  });
});
