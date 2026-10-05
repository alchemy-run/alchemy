import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Kubernetes from "@/Kubernetes";
import { KubernetesApiError } from "@/Kubernetes/internal/client.ts";
import {
  encodeSecretData,
  ensureNotControlled,
  scrubApiError,
  scrubSecretValues,
} from "@/Kubernetes/internal/secret.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Kubernetes.providers() });

const tags = ["provider:kubernetes", "provider:kubernetes:secret", "local"];

it.effect(
  "encodes Redacted values for the Kubernetes API",
  () =>
    Effect.gen(function* () {
      const value = Redacted.make("secret-value");
      const encoded = yield* encodeSecretData({ stringData: { token: value } });
      expect(encoded).toEqual({
        token: Buffer.from("secret-value", "utf8").toString("base64"),
      });
      expect(JSON.stringify(value)).toBe('"<redacted>"');
    }),
  { tags: ["unit", ...tags] },
);

it.effect(
  "passes binaryData through as base64 alongside stringData",
  () =>
    Effect.gen(function* () {
      const bytes = Buffer.from([0x00, 0xff, 0x10]).toString("base64");
      const encoded = yield* encodeSecretData({
        stringData: { password: Redacted.make("hunter2") },
        binaryData: { "keystore.jks": Redacted.make(bytes) },
      });
      expect(encoded).toEqual({
        password: Buffer.from("hunter2", "utf8").toString("base64"),
        "keystore.jks": bytes,
      });
    }),
  { tags: ["unit", ...tags] },
);

it.effect(
  "rejects a key present in both stringData and binaryData",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        encodeSecretData({
          stringData: { shared: Redacted.make("a"), only: Redacted.make("b") },
          binaryData: { shared: Redacted.make("Yg==") },
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("Kubernetes.SecretDataKeyConflict");
        expect(result.failure.keys).toEqual(["shared"]);
      }
    }),
  { tags: ["unit", ...tags] },
);

it.effect(
  "rejects binaryData that is not standard base64 without echoing the value",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        encodeSecretData({
          binaryData: {
            ok: Redacted.make("AP8Q"),
            wrapped: Redacted.make("AAAA\nAP8Q"),
            raw: Redacted.make("not base64!"),
            unpadded: Redacted.make("AP8"),
          },
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("Kubernetes.SecretDataNotBase64");
        expect(result.failure.keys).toEqual(["raw", "unpadded"]);
        expect(result.failure.message).not.toContain("not base64!");
      }
    }),
  { tags: ["unit", ...tags] },
);

const scrubData = {
  // `"` and `&` come back JSON-escaped (`\"`, Go's `&`) in a raw body.
  stringData: { password: Redacted.make('pa"ss&word') },
  binaryData: { "keystore.jks": Redacted.make(Buffer.from([0x00, 0xff, 0x10]).toString("base64")) },
};
const scrubNeedles = [
  'pa"ss&word',
  Buffer.from('pa"ss&word', "utf8").toString("base64"),
  Buffer.from([0x00, 0xff, 0x10]).toString("base64"),
];

it.effect(
  "scrubs Secret values from a JSON Status body",
  () =>
    Effect.gen(function* () {
      const body = JSON.stringify({
        kind: "Status",
        message: `admission webhook "policy.example.com" denied the request: password=pa"ss&word data=${scrubNeedles[1]} keystore=${scrubNeedles[2]}`,
        code: 403,
      }).replaceAll("&", "\\u0026");
      expect(body).not.toContain('pa"ss&word');
      const scrubbed = scrubSecretValues(body, scrubData);
      for (const needle of scrubNeedles) expect(scrubbed).not.toContain(needle);
      const status = JSON.parse(scrubbed) as { message: string; code: number };
      expect(status.code).toBe(403);
      expect(status.message).toBe(
        'admission webhook "policy.example.com" denied the request: password=<redacted> data=<redacted> keystore=<redacted>',
      );
    }),
  { tags: ["unit", ...tags] },
);

it.effect(
  "scrubs Secret values from a non-JSON body and keeps the error's fields",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        scrubApiError(
          new KubernetesApiError({
            method: "PATCH",
            path: "/api/v1/namespaces/apps/secrets/db",
            statusCode: 500,
            body: `upstream rejected pa"ss&word / ${scrubNeedles[2]}`,
          }),
          scrubData,
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.statusCode).toBe(500);
        expect(result.failure.path).toBe("/api/v1/namespaces/apps/secrets/db");
        expect(result.failure.body).toBe("upstream rejected <redacted> / <redacted>");
        for (const needle of scrubNeedles) expect(result.failure.message).not.toContain(needle);
      }
    }),
  { tags: ["unit", ...tags] },
);

it.effect(
  "refuses a live Secret that has a controller owner",
  () =>
    Effect.gen(function* () {
      const ref = { namespace: "apps", name: "db-credentials" };
      const owner = {
        apiVersion: "external-secrets.io/v1",
        kind: "ExternalSecret",
        name: "db-credentials",
        uid: "3f1c",
        controller: true,
      };
      const result = yield* Effect.result(
        ensureNotControlled(ref, { metadata: { ownerReferences: [owner] } }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("Kubernetes.SecretControlledByOwner");
        expect(result.failure.owner).toEqual(owner);
        expect(result.failure.message).toContain("ExternalSecret db-credentials");
      }
    }),
  { tags: ["unit", ...tags] },
);

it.effect(
  "applies over a missing Secret or one with only non-controller owners",
  () =>
    Effect.gen(function* () {
      const ref = { namespace: "apps", name: "db-credentials" };
      yield* ensureNotControlled(ref, undefined);
      yield* ensureNotControlled(ref, { metadata: {} });
      yield* ensureNotControlled(ref, {
        metadata: {
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "api" }],
        },
      });
    }),
  { tags: ["unit", ...tags] },
);

// Ungated probe. Like `Manifest`, a `Secret` lives inside the cluster and
// nothing on the cloud side attributes it to alchemy, so `list()` is
// intentionally empty. The full lifecycle is covered in Deployment.test.ts,
// which reuses that suite's gated EKS cluster instead of paying for another.
test.provider(
  "list returns an empty array (in-cluster objects)",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Kubernetes.Secret);
      const all = yield* provider.list();
      expect(all).toEqual([]);
    }),
  { tags },
);
