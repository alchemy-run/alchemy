import * as crypto from "node:crypto";
import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as Effect from "effect/Effect";
import { expectAuditEntry } from "../auditLogs.ts";
import { expectProbe } from "../bindingHost.ts";
import KmsBindingsHost, {
  AuditMarkers,
  Cipher,
  Kem,
  Keys,
  Mac,
  Raw,
  Signer,
  Unwrapper,
  Versions,
  Wrap,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "KmsBindings");

let baseUrl: string;
let auditMarkers: string;
let keyName: string;
let hostAccount: string;
let names: {
  ring: string;
  importJob: string;
  versions: string;
  signer: string;
  unwrapper: string;
  mac: string;
  raw: string;
  kem: string;
};

const hostRoles = (policy: kms.Policy) =>
  (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${hostAccount}`))
    .map((binding) => binding.role)
    .sort();

/**
 * The key's enabled version. A redeploy after destroy reclaims the key with
 * a fresh version (earlier ones stay destroyed), so it isn't always `1`.
 */
const enabledVersion = Effect.fn(function* (parent: string) {
  const { cryptoKeyVersions } = yield* kms.listProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions(
    { parent, filter: "state=ENABLED" },
  );
  return cryptoKeyVersions![0]!.name!.split("/").at(-1)!;
});

const keyRoles = Effect.fn(function* (resource: string) {
  return hostRoles(yield* kms.getIamPolicyProjectsLocationsKeyRingsCryptoKeys({ resource }));
});

describe(
  "KMS Bindings",
  { tags: ["provider:gcp", "provider:gcp:kms", "provider:gcp:run", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* KmsBindingsHost;
            const key = yield* Cipher;
            return {
              names: {
                ring: (yield* Keys).name,
                importJob: (yield* Wrap).name,
                versions: (yield* Versions).name,
                signer: (yield* Signer).name,
                unwrapper: (yield* Unwrapper).name,
                mac: (yield* Mac).name,
                raw: (yield* Raw).name,
                kem: (yield* Kem).name,
              },
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              auditMarkers: (yield* AuditMarkers).bucketName,
              key: key.name,
            };
          }),
        );
        baseUrl = out.uri!;
        auditMarkers = out.auditMarkers;
        keyName = out.key;
        names = out.names;
        hostAccount = out.serviceAccount!;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    const live = {
      tags: ["provider:gcp", "provider:gcp:kms", "live"],
      timeout: 600_000,
    };

    describe("Encrypt / Decrypt", () => {
      test.provider(
        "round-trip as the host's service account, granted on the key only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              plaintext: string;
              ciphertext: string;
              decrypted: string;
            }>(baseUrl, "roundTrip");
            expect(out.ciphertext).not.toEqual(out.plaintext);
            expect(out.decrypted).toEqual(out.plaintext);

            const policy = yield* kms.getIamPolicyProjectsLocationsKeyRingsCryptoKeys({
              resource: keyName,
            });
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
              )
              .map((binding) => binding.role)
              .sort();
            expect(roles).toEqual([
              "roles/cloudkms.cryptoKeyDecrypter",
              "roles/cloudkms.cryptoKeyEncrypter",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:kms", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetKeyRing / ListKeyRingCryptoKeys / ListKeyRingImportJobs / GetImportJob", () => {
      test.provider(
        "reads the key ring and import job as the host, granted on each only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              ring: { name?: string };
              keys: { cryptoKeys?: { name?: string }[] };
              importJobs: { importJobs?: { name?: string }[] };
              importJob: { name?: string; importMethod?: string };
            }>(baseUrl, "keyRing");
            expect(out.ring.name).toEqual(names.ring);
            expect(out.keys.cryptoKeys?.map((k) => k.name)).toEqual(
              expect.arrayContaining([keyName, names.versions, names.signer]),
            );
            expect(out.importJobs.importJobs?.map((j) => j.name)).toContain(names.importJob);
            expect(out.importJob).toMatchObject({
              name: names.importJob,
              importMethod: "RSA_OAEP_3072_SHA256_AES_256",
            });

            expect(
              hostRoles(yield* kms.getIamPolicyProjectsLocationsKeyRings({ resource: names.ring })),
            ).toEqual(["roles/cloudkms.encryptionDashboardViewer", "roles/cloudkms.viewer"]);
            expect(
              hostRoles(
                yield* kms.getIamPolicyProjectsLocationsKeyRingsImportJobs({
                  resource: names.importJob,
                }),
              ),
            ).toEqual(["roles/cloudkms.viewer"]);
          }),
        live,
      );
    });

    describe("GetCryptoKey / CreateCryptoKeyVersion / ListCryptoKeyVersions / GetCryptoKeyVersion / UpdateCryptoKeyPrimaryVersion / PatchCryptoKeyVersion / DestroyCryptoKeyVersion / RestoreCryptoKeyVersion / DeleteCryptoKeyVersion", () => {
      test.provider(
        "manages the key's versions as the host, granted on the key only",
        (_stack) =>
          Effect.gen(function* () {
            const versionId = (name?: string) => name!.split("/").at(-1)!;

            const primary = yield* expectProbe<kms.CryptoKeyVersion>(baseUrl, "createVersion");
            const id = versionId(primary.name);
            const updated = yield* expectProbe<kms.CryptoKey>(
              baseUrl,
              `updatePrimary?version=${id}`,
            );
            expect(updated.primary?.name).toEqual(primary.name);
            const key = yield* expectProbe<kms.CryptoKey>(baseUrl, "getCryptoKey");
            expect(key).toMatchObject({ name: names.versions, primary: { name: primary.name } });

            const spare = yield* expectProbe<kms.CryptoKeyVersion>(baseUrl, "createVersion");
            const spareId = versionId(spare.name);
            const listed = yield* expectProbe<{ cryptoKeyVersions?: { name?: string }[] }>(
              baseUrl,
              "listVersions",
            );
            expect(listed.cryptoKeyVersions?.map((v) => v.name)).toEqual(
              expect.arrayContaining([primary.name, spare.name]),
            );

            const disabled = yield* expectProbe<kms.CryptoKeyVersion>(
              baseUrl,
              `disableVersion?version=${spareId}`,
            );
            expect(disabled.state).toEqual("DISABLED");
            const destroyed = yield* expectProbe<kms.CryptoKeyVersion>(
              baseUrl,
              `destroyVersion?version=${spareId}`,
            );
            expect(destroyed.state).toEqual("DESTROY_SCHEDULED");
            const restored = yield* expectProbe<kms.CryptoKeyVersion>(
              baseUrl,
              `restoreVersion?version=${spareId}`,
            );
            expect(restored.state).toEqual("DISABLED");
            const got = yield* expectProbe<kms.CryptoKeyVersion>(
              baseUrl,
              `getVersion?version=${spareId}`,
            );
            expect(got).toMatchObject({ name: spare.name, state: "DISABLED" });
            expect(yield* expectProbe<string>(baseUrl, `deleteVersion?version=${spareId}`)).toEqual(
              "BadRequest",
            );

            expect(yield* keyRoles(names.versions)).toEqual([
              "roles/cloudkms.admin",
              "roles/cloudkms.viewer",
            ]);
          }),
        live,
      );
    });

    describe("GetPublicKey / AsymmetricSign / AsymmetricDecrypt", () => {
      test.provider(
        "signs and decrypts with asymmetric keys as the host, granted on each key only",
        (_stack) =>
          Effect.gen(function* () {
            const message = Buffer.from("alchemy-kms-asymmetric");
            const digest = yield* Effect.sync(() =>
              crypto.createHash("sha256").update(message).digest("base64"),
            );
            const signed = yield* expectProbe<{ pem: string; signature: string }>(
              baseUrl,
              `sign?version=${yield* enabledVersion(names.signer)}&digest=${encodeURIComponent(digest)}`,
            );
            const verified = yield* Effect.sync(() =>
              crypto.verify("sha256", message, signed.pem, Buffer.from(signed.signature, "base64")),
            );
            expect(verified).toBe(true);

            const unwrapperVersion = yield* enabledVersion(names.unwrapper);
            const publicKey = yield* expectProbe<{ pem: string }>(
              baseUrl,
              `unwrapperPublicKey?version=${unwrapperVersion}`,
            );
            const ciphertext = yield* Effect.sync(() =>
              crypto
                .publicEncrypt(
                  {
                    key: publicKey.pem,
                    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: "sha256",
                  },
                  message,
                )
                .toString("base64"),
            );
            const decrypted = yield* expectProbe<{ plaintext: string }>(
              baseUrl,
              `asymmetricDecrypt?version=${unwrapperVersion}&ciphertext=${encodeURIComponent(ciphertext)}`,
            );
            expect(Buffer.from(decrypted.plaintext, "base64").toString()).toEqual(
              message.toString(),
            );

            expect(yield* keyRoles(names.signer)).toEqual([
              "roles/cloudkms.publicKeyViewer",
              "roles/cloudkms.signer",
            ]);
            expect(yield* keyRoles(names.unwrapper)).toEqual([
              "roles/cloudkms.cryptoKeyDecrypter",
              "roles/cloudkms.publicKeyViewer",
            ]);
          }),
        live,
      );
    });

    describe("MacSign / MacVerify / RawEncrypt / RawDecrypt / Decapsulate", () => {
      test.provider(
        "signs, verifies and raw-encrypts as the host, granted on each key only",
        (_stack) =>
          Effect.gen(function* () {
            expect(
              yield* expectProbe<{ valid: boolean; tampered: boolean }>(
                baseUrl,
                `mac?version=${yield* enabledVersion(names.mac)}`,
              ),
            ).toEqual({ valid: true, tampered: false });
            const raw = yield* expectProbe<{ plaintext: string; decrypted: string }>(
              baseUrl,
              `raw?version=${yield* enabledVersion(names.raw)}`,
            );
            expect(raw.decrypted).toEqual(raw.plaintext);
            expect(
              yield* expectProbe<string>(
                baseUrl,
                `decapsulate?version=${yield* enabledVersion(names.kem)}`,
              ),
            ).toEqual("BadRequest");

            expect(yield* keyRoles(names.mac)).toEqual([
              "roles/cloudkms.signer",
              "roles/cloudkms.verifier",
            ]);
            expect(yield* keyRoles(names.raw)).toEqual([
              "roles/cloudkms.cryptoKeyDecrypter",
              "roles/cloudkms.cryptoKeyEncrypter",
            ]);
            expect(yield* keyRoles(names.kem)).toEqual(["roles/cloudkms.decapsulator"]);
          }),
        live,
      );
    });

    describe("consumeKeyRingAuditLogs / consumeCryptoKeyAuditLogs / consumeImportJobAuditLogs", () => {
      test.provider(
        "deliver each resource's audit log entries to the host",
        (_stack) =>
          Effect.gen(function* () {
            // Admin Activity calls that change nothing (or only a description).
            const cases = [
              {
                key: "keyRing",
                name: names.ring,
                method: "SetIamPolicy",
                trigger: kms.getIamPolicyProjectsLocationsKeyRings({ resource: names.ring }).pipe(
                  Effect.flatMap((policy) =>
                    kms.setIamPolicyProjectsLocationsKeyRings({
                      resource: names.ring,
                      body: { policy },
                    }),
                  ),
                ),
              },
              {
                key: "cryptoKey",
                name: names.versions,
                method: "SetIamPolicy",
                trigger: kms
                  .getIamPolicyProjectsLocationsKeyRingsCryptoKeys({ resource: names.versions })
                  .pipe(
                    Effect.flatMap((policy) =>
                      kms.setIamPolicyProjectsLocationsKeyRingsCryptoKeys({
                        resource: names.versions,
                        body: { policy },
                      }),
                    ),
                  ),
              },
              {
                key: "importJob",
                name: names.importJob,
                method: "SetIamPolicy",
                trigger: kms
                  .getIamPolicyProjectsLocationsKeyRingsImportJobs({ resource: names.importJob })
                  .pipe(
                    Effect.flatMap((policy) =>
                      kms.setIamPolicyProjectsLocationsKeyRingsImportJobs({
                        resource: names.importJob,
                        body: { policy },
                      }),
                    ),
                  ),
              },
            ];
            for (const { key, name, method, trigger } of cases) {
              const entry = yield* expectAuditEntry({ bucket: auditMarkers, key, method, trigger });
              expect(entry.serviceName).toEqual("cloudkms.googleapis.com");
              // Audit logs may name the project by number.
              const path = (value: string) => value.replace(/^projects\/[^/]+/, "");
              expect(path(entry.resourceName)).toContain(path(name));
            }
          }),
        { tags: ["provider:gcp", "live"], timeout: 900_000 },
      );
    });

    describe("project bindings", () => {
      test.provider(
        "lists a location's key rings, EKM connections, key handles, retired resources and HSM instances",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ rings: string[]; rest: string[] }>(baseUrl, "project");
            expect(out.rings).toContain(names.ring);
            // The project has none of the others: each call is authorized.
            expect(out.rest).toEqual(["object", "object", "object", "object"]);
          }),
        { tags: ["provider:gcp", "provider:gcp:kms", "live"], timeout: 600_000 },
      );
    });
  },
);
