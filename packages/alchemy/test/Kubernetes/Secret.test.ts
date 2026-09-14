import * as Kubernetes from "@/Kubernetes";
import { encodeSecretData } from "@/Kubernetes/internal/secret.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Kubernetes.providers() });

it.effect("encodes Redacted values for the Kubernetes API", () =>
  Effect.gen(function* () {
    const value = Redacted.make("secret-value");
    const encoded = yield* encodeSecretData({ stringData: { token: value } });
    expect(encoded).toEqual({
      token: Buffer.from("secret-value", "utf8").toString("base64"),
    });
    expect(JSON.stringify(value)).toBe('"<redacted>"');
  }),
);

it.effect("passes binaryData through as base64 alongside stringData", () =>
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
);

it.effect("rejects a key present in both stringData and binaryData", () =>
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
);

// Ungated probe. Like `Manifest`, a `Secret` lives inside the cluster and
// nothing on the cloud side attributes it to alchemy, so `list()` is
// intentionally empty. The full lifecycle is covered in Deployment.test.ts,
// which reuses that suite's gated EKS cluster instead of paying for another.
test.provider("list returns an empty array (in-cluster objects)", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Kubernetes.Secret);
    const all = yield* provider.list();
    expect(all).toEqual([]);
  }),
);
