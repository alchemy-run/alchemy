import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetAppsSecretsFind } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Stripe.providers() });

const ACCOUNT_SCOPE = { type: "account" } as const;

/**
 * Obviously-fake payloads. Nothing here is a credential; the tests assert
 * these strings never make it back out through the resource's attributes.
 */
const PAYLOAD_V1 = "alchemy-fake-payload-v1-not-a-real-secret";
const PAYLOAD_V2 = "alchemy-fake-payload-v2-not-a-real-secret";

const sha256Hex = /^[0-9a-f]{64}$/;

/** The payload must never leak into the resource's attributes. */
const expectNoPayload = (secret: object, payload: string) => {
  expect((secret as Record<string, unknown>).payload).toBeUndefined();
  expect(JSON.stringify(secret)).not.toContain(payload);
};

/** Out-of-band: read the live secret straight from Stripe. */
const findSecret = (name: string) =>
  GetAppsSecretsFind({ name, scope: ACCOUNT_SCOPE });

/** Out-of-band: assert Stripe no longer holds a secret under this name. */
const expectGone = (name: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(findSecret(name));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      // Stripe answers a missing object with HTTP 404 +
      // `type: "invalid_request_error"`, `code: "resource_missing"`;
      // distilled dispatches on `type` first, so either tag is valid.
      expect(["NotFound", "InvalidRequestError"]).toContain(
        result.failure._tag,
      );
    }
  });

test.provider("create a minimal account-scoped secret and delete it", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy_test_apps_secret_minimal";

    const secret = yield* stack.deploy(
      Stripe.AppsSecret("MinimalSecret", {
        name,
        scope: { type: "account" },
        payload: Redacted.make(PAYLOAD_V1),
      }),
    );

    expect(secret.secretId).toBeDefined();
    expect(secret.name).toEqual(name);
    expect(secret.scope).toEqual({ type: "account" });
    expect(secret.expiresAt).toBeUndefined();
    expect(secret.livemode).toEqual(false);
    expect(secret.payloadHash).toMatch(sha256Hex);
    expectNoPayload(secret, PAYLOAD_V1);

    // Out-of-band: the plaintext really did land in the Secret Store.
    const fetched = yield* findSecret(name);
    expect(fetched.id).toEqual(secret.secretId);
    expect(fetched.name).toEqual(name);
    expect(fetched.payload).toEqual(PAYLOAD_V1);
    expect(fetched.scope.type).toEqual("account");

    yield* stack.destroy();

    yield* expectGone(name);
  }),
);

test.provider("create a fully-configured secret with an expiry", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy_test_apps_secret_full";
    // Stripe rejects an expiry in the past, so it has to be relative to now.
    // It is a value, not an identifier — the resource's identity is
    // `(name, scope)` and stays deterministic across runs.
    const expiresAt = yield* Effect.sync(
      () => Math.floor(Date.now() / 1000) + 3600,
    );

    const secret = yield* stack.deploy(
      Stripe.AppsSecret("FullSecret", {
        name,
        scope: { type: "account" },
        payload: Redacted.make(PAYLOAD_V1),
        expiresAt,
      }),
    );

    expect(secret.secretId).toBeDefined();
    expect(secret.name).toEqual(name);
    expect(secret.expiresAt).toEqual(expiresAt);
    expect(secret.created).toBeDefined();
    expect(secret.payloadHash).toMatch(sha256Hex);
    expectNoPayload(secret, PAYLOAD_V1);

    const fetched = yield* findSecret(name);
    expect(fetched.expires_at).toEqual(expiresAt);
    expect(fetched.payload).toEqual(PAYLOAD_V1);

    yield* stack.destroy();

    yield* expectGone(name);
  }),
);

test.provider("rotating the payload updates the secret in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy_test_apps_secret_rotate";

    const created = yield* stack.deploy(
      Stripe.AppsSecret("RotatedSecret", {
        name,
        scope: { type: "account" },
        payload: Redacted.make(PAYLOAD_V1),
      }),
    );
    expect(created.payloadHash).toMatch(sha256Hex);

    const before = yield* findSecret(name);
    expect(before.payload).toEqual(PAYLOAD_V1);

    const rotated = yield* stack.deploy(
      Stripe.AppsSecret("RotatedSecret", {
        name,
        scope: { type: "account" },
        payload: Redacted.make(PAYLOAD_V2),
      }),
    );

    // The natural key is unchanged, so this is an update, not a replacement.
    expect(rotated.name).toEqual(created.name);
    expect(rotated.scope).toEqual(created.scope);
    expect(rotated.secretId).toEqual(created.secretId);
    expect(rotated.payloadHash).not.toEqual(created.payloadHash);
    expectNoPayload(rotated, PAYLOAD_V2);

    const fetched = yield* findSecret(name);
    expect(fetched.payload).toEqual(PAYLOAD_V2);

    yield* stack.destroy();

    yield* expectGone(name);
  }),
);

test.provider("re-deploying an unchanged secret is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy_test_apps_secret_noop";
    const deploy = stack.deploy(
      Stripe.AppsSecret("StableSecret", {
        name,
        scope: { type: "account" },
        payload: Redacted.make(PAYLOAD_V1),
      }),
    );

    const created = yield* deploy;
    const again = yield* deploy;

    expect(again.secretId).toEqual(created.secretId);
    expect(again.name).toEqual(created.name);
    expect(again.created).toEqual(created.created);
    expect(again.payloadHash).toEqual(created.payloadHash);

    yield* stack.destroy();

    yield* expectGone(name);
  }),
);

test.provider("changing the name replaces the secret", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const originalName = "alchemy_test_apps_secret_replace_a";
    const replacedName = "alchemy_test_apps_secret_replace_b";

    const created = yield* stack.deploy(
      Stripe.AppsSecret("ReplacedSecret", {
        name: originalName,
        scope: { type: "account" },
        payload: Redacted.make(PAYLOAD_V1),
      }),
    );
    expect(created.name).toEqual(originalName);

    const replaced = yield* stack.deploy(
      Stripe.AppsSecret("ReplacedSecret", {
        name: replacedName,
        scope: { type: "account" },
        payload: Redacted.make(PAYLOAD_V1),
      }),
    );

    // `name` is part of the natural key and immutable — the resource is
    // replaced, so Stripe hands back a different object.
    expect(replaced.name).toEqual(replacedName);
    expect(replaced.secretId).not.toEqual(created.secretId);

    const fetched = yield* findSecret(replacedName);
    expect(fetched.id).toEqual(replaced.secretId);
    expect(fetched.payload).toEqual(PAYLOAD_V1);

    // The replaced generation was deleted.
    yield* expectGone(originalName);

    yield* stack.destroy();

    yield* expectGone(replacedName);
  }),
);
