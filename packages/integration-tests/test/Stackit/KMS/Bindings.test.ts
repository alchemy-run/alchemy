import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as kms from "@distilled.cloud/stackit/kms";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import KmsBindingsWorker, {
  DataKey,
  ImportedKey,
  Ring,
  SigningKey,
  VersionsKey,
  Wrapper,
} from "./fixtures/worker.ts";
import { ringRequest, slow } from "./kms.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitKmsBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* KmsBindingsWorker;
    const ring = yield* Ring;
    const dataKey = yield* DataKey;
    const signingKey = yield* SigningKey;
    const versionsKey = yield* VersionsKey;
    const importedKey = yield* ImportedKey;
    const wrapper = yield* Wrapper;
    return {
      url: worker.url.as<string>(),
      projectId: ring.projectId,
      region: ring.region,
      keyRingId: ring.keyRingId,
      dataKeyId: dataKey.keyId,
      signingKeyId: signingKey.keyId,
      versionsKeyId: versionsKey.keyId,
      importedKeyId: importedKey.keyId,
      wrappingKeyId: wrapper.wrappingKeyId,
      wrappingPublicKey: wrapper.publicKey,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const toBase64 = (text: string) => Base64.encode(new TextEncoder().encode(text));

/** The DER bytes of a public key, whether STACKIT hands out PEM or bare base64. */
const publicKeyDer = (publicKey: string) => {
  const body = publicKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
};

/** Wrap fresh AES-256 material with the deployed wrapping key, as a customer would. */
const wrapMaterial = (publicKey: string) =>
  Effect.tryPromise(async () => {
    const wrapping = await crypto.subtle.importKey(
      "spki",
      publicKeyDer(publicKey),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const material = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, wrapping, material);
    return Base64.encode(new Uint8Array(wrapped));
  });

// Key versions are billed (see `kms.ts`), so the suite is gated. The version
// operations share one key, so the bindings run one after another.
describe.sequential.skipIf(slow)(
  "STACKIT KMS bindings on a Cloudflare Worker",
  { tags: [...stackitTags("kms", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take
    // a while to propagate: retry until the route answers `ok`, then report the
    // last answer so a real failure shows its STACKIT error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** Identifiers of a deployed key, for out-of-band calls. */
    const keyRequest = (select: "dataKeyId" | "signingKeyId" | "versionsKeyId" | "importedKeyId") =>
      Effect.gen(function* () {
        const outputs = yield* stack;
        return {
          ...ringRequest(
            { projectId: outputs.projectId!, region: outputs.region! },
            outputs.keyRingId!,
          ),
          keyId: outputs[select]!,
        };
      });

    /** Bounded wait until a version of the versions key reaches a state. */
    const waitForVersion = (versionNumber: number, until: (version: kms.Version) => boolean) =>
      Effect.gen(function* () {
        const request = yield* keyRequest("versionsKeyId");
        return yield* kms.getVersion({ ...request, versionNumber }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until,
            times: 20,
          }),
        );
      });

    describe("Encrypt", () => {
      test.provider(
        "encrypts with the latest version, and the result decrypts out of band",
        (_stack) =>
          Effect.gen(function* () {
            const text = "encrypted by a binding";
            const body = yield* call("/encrypt", { text });
            expectOk(body);
            expect(body.result.version).toBe(1);
            expect(body.result.ciphertext).not.toBe(toBase64(text));

            const request = yield* keyRequest("dataKeyId");
            const { data } = yield* kms.decrypt({
              ...request,
              versionNumber: body.result.version,
              data: body.result.ciphertext,
            });
            expect(Redacted.isRedacted(data)).toBe(true);
            expect(Redacted.value(data as Redacted.Redacted<string>)).toBe(toBase64(text));
          }),
        { timeout: 240_000 },
      );
    });

    describe("Decrypt", () => {
      test.provider(
        "returns the plaintext redacted",
        (_stack) =>
          Effect.gen(function* () {
            const text = "encrypted out of band";
            const request = yield* keyRequest("dataKeyId");
            const { data } = yield* kms.encrypt({
              ...request,
              versionNumber: 1,
              data: toBase64(text),
            });

            const body = yield* call("/decrypt", { ciphertext: data, version: "1" });
            expectOk(body);
            expect(body.result.text).toBe(text);
            expect(body.result.redacted).toBe(true);
            expect(body.result.printed).not.toContain(text);
          }),
        { timeout: 240_000 },
      );
    });

    describe("Sign", () => {
      test.provider(
        "signs with the latest version, and the signature verifies out of band",
        (_stack) =>
          Effect.gen(function* () {
            const text = "signed by a binding";
            const body = yield* call("/sign", { text });
            expectOk(body);
            expect(body.result.version).toBe(1);

            const request = yield* keyRequest("signingKeyId");
            const { valid } = yield* kms.verify({
              ...request,
              versionNumber: body.result.version,
              data: toBase64(text),
              signature: body.result.signature,
            });
            expect(valid).toBe(true);
          }),
        { timeout: 240_000 },
      );
    });

    describe("Verify", () => {
      test.provider(
        "accepts a real signature and rejects it on other data",
        (_stack) =>
          Effect.gen(function* () {
            const text = "signed out of band";
            const request = yield* keyRequest("signingKeyId");
            const { signature } = yield* kms.sign({
              ...request,
              versionNumber: 1,
              data: toBase64(text),
            });

            const good = yield* call("/verify", { text, signature, version: "1" });
            expectOk(good);
            expect(good.result.valid).toBe(true);

            const bad = yield* call("/verify", { text: `${text}!`, signature, version: "1" });
            expectOk(bad);
            expect(bad.result.valid).toBe(false);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetKey", () => {
      test.provider(
        "reads the bound key",
        (_stack) =>
          Effect.gen(function* () {
            const { dataKeyId, keyRingId } = yield* stack;
            const body = yield* call("/get-key");
            expectOk(body);
            expect(body.result.id).toBe(dataKeyId);
            expect(body.result.keyRingId).toBe(keyRingId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetVersion", () => {
      test.provider(
        "reads a version with its public key",
        (_stack) =>
          Effect.gen(function* () {
            const { signingKeyId } = yield* stack;
            const body = yield* call("/get-version", { version: "1" });
            expectOk(body);
            expect(body.result.keyId).toBe(signingKeyId);
            expect(body.result.number).toBe(1);
            expect(body.result.publicKey.length).toBeGreaterThan(0);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListVersions", () => {
      test.provider(
        "lists the bound key's versions",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-versions");
            expectOk(body);
            expect(body.result.versions.map((version: kms.Version) => version.number)).toEqual([1]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetKeyRing", () => {
      test.provider(
        "reads the bound ring",
        (_stack) =>
          Effect.gen(function* () {
            const { keyRingId } = yield* stack;
            const body = yield* call("/get-key-ring");
            expectOk(body);
            expect(body.result.id).toBe(keyRingId);
            expect(body.result.state).toBe("active");
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListKeys", () => {
      test.provider(
        "lists the bound ring's keys",
        (_stack) =>
          Effect.gen(function* () {
            const { dataKeyId, signingKeyId } = yield* stack;
            const body = yield* call("/list-keys");
            expectOk(body);
            const ids = body.result.keys.map((key: kms.Key) => key.id);
            expect(ids).toContain(dataKeyId);
            expect(ids).toContain(signingKeyId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListKeyRings", () => {
      test.provider(
        "lists the rings of the bound ring's project",
        (_stack) =>
          Effect.gen(function* () {
            const { keyRingId } = yield* stack;
            const body = yield* call("/list-key-rings");
            expectOk(body);
            expect(body.result.keyRings.map((ring: kms.KeyRing) => ring.id)).toContain(keyRingId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetWrappingKey", () => {
      test.provider(
        "reads the bound wrapping key",
        (_stack) =>
          Effect.gen(function* () {
            const { wrappingKeyId, wrappingPublicKey } = yield* stack;
            const body = yield* call("/get-wrapping-key");
            expectOk(body);
            expect(body.result.id).toBe(wrappingKeyId);
            expect(body.result.publicKey).toBe(wrappingPublicKey);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListWrappingKeys", () => {
      test.provider(
        "lists the bound ring's wrapping keys",
        (_stack) =>
          Effect.gen(function* () {
            const { wrappingKeyId } = yield* stack;
            const body = yield* call("/list-wrapping-keys");
            expectOk(body);
            expect(
              body.result.wrappingKeys.map((wrappingKey: kms.WrappingKey) => wrappingKey.id),
            ).toContain(wrappingKeyId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("RotateKey", () => {
      test.provider(
        "creates a newer version",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/rotate-key");
            expectOk(body);
            expect(body.result.number).toBeGreaterThan(1);

            const request = yield* keyRequest("versionsKeyId");
            const { versions } = yield* kms.listVersions(request);
            expect(versions.map((version) => version.number)).toContain(body.result.number);
          }),
        { timeout: 240_000 },
      );
    });

    // Version 1 of the versions key: the rotation above left a newer one active.
    describe("DisableVersion", () => {
      test.provider(
        "disables a version",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/disable-version", { version: "1" });
            expectOk(body);
            const version = yield* waitForVersion(1, (observed) => observed.disabled);
            expect(version.disabled).toBe(true);
          }),
        { timeout: 240_000 },
      );
    });

    describe("EnableVersion", () => {
      test.provider(
        "enables a disabled version again",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/enable-version", { version: "1" });
            expectOk(body);
            const version = yield* waitForVersion(1, (observed) => !observed.disabled);
            expect(version.disabled).toBe(false);
            expect(version.state).toBe("active");
          }),
        { timeout: 240_000 },
      );
    });

    describe("DestroyVersion", () => {
      test.provider(
        "schedules a version's key material for destruction",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/destroy-version", { version: "1" });
            expectOk(body);
            const version = yield* waitForVersion(
              1,
              (observed) => observed.state === "destroyed" || observed.destroyDate !== undefined,
            );
            expect(version.state === "destroyed" || version.destroyDate !== undefined).toBe(true);
          }),
        { timeout: 240_000 },
      );
    });

    describe("RestoreVersion", () => {
      test.provider(
        "undoes the destruction",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/restore-version", { version: "1" });
            expectOk(body);
            const version = yield* waitForVersion(
              1,
              (observed) => observed.state !== "destroyed" && observed.destroyDate === undefined,
            );
            expect(version.state).not.toBe("destroyed");
            expect(version.destroyDate).toBeUndefined();
          }),
        { timeout: 240_000 },
      );
    });

    describe("ImportKey", () => {
      test.provider(
        "imports wrapped material as the first version of an import-only key",
        (_stack) =>
          Effect.gen(function* () {
            const { wrappingKeyId, wrappingPublicKey } = yield* stack;
            const wrapped = yield* wrapMaterial(wrappingPublicKey!);
            const body = yield* call("/import-key", { wrapped, wrappingKeyId: wrappingKeyId! });
            expectOk(body);
            expect(body.result.number).toBe(1);

            const request = yield* keyRequest("importedKeyId");
            const { versions } = yield* kms.listVersions(request);
            expect(versions.map((version) => version.number)).toEqual([1]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ReadKey", () => {
      test.provider(
        "reads the bound key and its versions",
        (_stack) =>
          Effect.gen(function* () {
            const { dataKeyId } = yield* stack;
            const body = yield* call("/read-key", { version: "1" });
            expectOk(body);
            expect(body.result.key.id).toBe(dataKeyId);
            expect(body.result.version.number).toBe(1);
            expect(body.result.versions.versions.length).toBeGreaterThan(0);
          }),
        { timeout: 240_000 },
      );
    });

    describe("WriteKey", () => {
      test.provider(
        "rotates the bound key",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/write-key");
            expectOk(body);
            const request = yield* keyRequest("versionsKeyId");
            const { versions } = yield* kms.listVersions(request);
            expect(versions.map((version) => version.number)).toContain(body.result.number);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ReadWriteKey", () => {
      test.provider(
        "rotates the bound key and reads the new version back",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/read-write-key");
            expectOk(body);
            expect(body.result.versions).toContain(body.result.rotated);
          }),
        { timeout: 240_000 },
      );
    });
  },
);
