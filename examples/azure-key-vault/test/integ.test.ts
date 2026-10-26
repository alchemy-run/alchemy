import { expect } from "bun:test";
import * as crypto from "node:crypto";
import * as Azure from "@alchemy.run/azure";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Bun";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import Stack, { providers } from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM reads. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// A standard vault (software keys at $0.03 per 10k operations), one Flex
// Consumption app (billed per execution) and its storage account: about
// $0.01 per run, so the test is not gated.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

class Unexpected extends Data.TaggedError("Unexpected")<{
  readonly status: number;
  readonly body: string;
}> {}

const baseUrl = Effect.map(stack, ({ url }) => String(url).replace(/\/+$/, ""));
const initialApiKey = Effect.map(stack, ({ apiKey }) => Redacted.value(apiKey));

/**
 * Call the API and expect `status`. Retries through the Flex Consumption
 * cold start and the app's role assignments propagating after the first
 * deploy (the API answers 503 with the Key Vault error until then).
 */
const call = <T>(
  method: "GET" | "POST",
  path: string,
  options: { apiKey?: string; body?: unknown; status?: number } = {},
) =>
  Effect.gen(function* () {
    const base = yield* baseUrl;
    const target = `${base}${path}`;
    const bare =
      method === "GET"
        ? HttpClientRequest.get(target)
        : HttpClientRequest.post(target).pipe(HttpClientRequest.bodyJsonUnsafe(options.body ?? {}));
    const request =
      options.apiKey === undefined
        ? bare
        : bare.pipe(HttpClientRequest.setHeader("x-api-key", options.apiKey));
    const res = yield* HttpClient.execute(request);
    const text = yield* res.text;
    const expected = options.status ?? 200;
    if (res.status !== expected) return yield* new Unexpected({ status: res.status, body: text });
    return JSON.parse(text) as T;
  }).pipe(
    Effect.tapError((error) => Effect.logWarning(error)),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
  );

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, resourceGroupName: outputs.resourceGroup, outputs };
});

type Where = Effect.Success<typeof where>;

const versionOf = (uri: string | undefined) => uri?.split("/").pop() ?? "";

/** The current version of a key, as Azure Resource Manager sees it. */
const armKeyVersion = ({ subscriptionId, resourceGroupName, outputs }: Where, keyName: string) =>
  keyvault
    .GetKey({ subscriptionId, resourceGroupName, vaultName: outputs.vaultName, keyName })
    .pipe(
      Effect.map((key) => versionOf(key.properties.keyUriWithVersion)),
      Effect.provide(azure),
    );

/** The current version of the API key secret, as Azure Resource Manager sees it. */
const armSecretVersion = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  keyvault
    .GetSecret({
      subscriptionId,
      resourceGroupName,
      vaultName: outputs.vaultName,
      secretName: outputs.secretName,
    })
    .pipe(
      Effect.map((secret) => versionOf(secret.properties.secretUriWithVersion)),
      Effect.provide(azure),
    );

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (current) => current === "gone",
      times: 24,
    }),
  );

const vaultStatus = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  keyvault.GetVault({ subscriptionId, resourceGroupName, vaultName: outputs.vaultName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.provide(azure),
  );

/** A destroyed vault is purged too, so no soft-deleted vault holds its name. */
const deletedVaultStatus = ({ subscriptionId, outputs }: Where) =>
  keyvault
    .GetVaultDeleted({ subscriptionId, location: outputs.location, vaultName: outputs.vaultName })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "NotFound"], () => Effect.succeed("gone" as const)),
      Effect.provide(azure),
    );

const appStatus = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  web.GetWebApp({ subscriptionId, resourceGroupName, name: outputs.functionAppName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.provide(azure),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const deployed = yield* stack;
    yield* destroy(Stack);
    // A failed deploy has no outputs to check against.
    if (deployed === undefined) return;
    const ids = yield* where;
    expect(yield* untilGone(vaultStatus(ids))).toBe("gone");
    expect(yield* untilGone(deletedVaultStatus(ids))).toBe("gone");
    expect(yield* untilGone(appStatus(ids))).toBe("gone");
  }),
  { timeout: 900_000 },
);

test(
  "rejects a request without the API key",
  Effect.gen(function* () {
    const missing = yield* call<{ error: string }>("POST", "/sign", {
      body: { message: "hello" },
      status: 401,
    });
    expect(missing.error).toBe("missing or wrong x-api-key");
    const wrong = yield* call<{ error: string }>("POST", "/sign", {
      apiKey: "not-the-key",
      body: { message: "hello" },
      status: 401,
    });
    expect(wrong.error).toBe("missing or wrong x-api-key");
  }),
  { timeout: 600_000 },
);

test(
  "encrypts and decrypts a message with the data key",
  Effect.gen(function* () {
    const apiKey = yield* initialApiKey;
    const ids = yield* where;

    const { ciphertext } = yield* call<{ ciphertext: string }>("POST", "/encrypt", {
      apiKey,
      body: { plaintext: "card 4111 1111 1111 1111" },
    });
    // The ciphertext names the key version that made it: the data key's
    // current version in Azure Resource Manager.
    const [version, value] = ciphertext.split(".");
    expect(version).toBe(yield* armKeyVersion(ids, ids.outputs.dataKeyName));
    // A 2048-bit RSA ciphertext is 256 bytes, 342 characters of base64url.
    expect(value).toHaveLength(342);

    const { plaintext } = yield* call<{ plaintext: string }>("POST", "/decrypt", {
      apiKey,
      body: { ciphertext },
    });
    expect(plaintext).toBe("card 4111 1111 1111 1111");

    const tooLong = yield* call<{ error: string }>("POST", "/encrypt", {
      apiKey,
      body: { plaintext: "x".repeat(191) },
      status: 400,
    });
    expect(tooLong.error).toBe("plaintext is over 190 bytes");
  }),
  { timeout: 600_000 },
);

test(
  "signs a message that the published public key verifies",
  Effect.gen(function* () {
    const apiKey = yield* initialApiKey;
    const ids = yield* where;
    const message = "ship order 42";

    const signed = yield* call<{ kid: string; alg: string; signature: string }>("POST", "/sign", {
      apiKey,
      body: { message },
    });
    expect(signed.alg).toBe("ES256");
    expect(versionOf(signed.kid)).toBe(yield* armKeyVersion(ids, ids.outputs.signingKeyName));

    // Anyone can check the signature offline with the published JWKS.
    const jwks = yield* call<{ keys: crypto.webcrypto.JsonWebKey[] }>("GET", "/jwks", { apiKey });
    expect(jwks.keys).toHaveLength(1);
    const [jwk] = jwks.keys;
    expect(jwk).toMatchObject({ kid: signed.kid, kty: "EC", crv: "P-256", alg: "ES256" });
    expect(Object.keys(jwk!)).not.toContain("d");
    const offline = yield* Effect.sync(() =>
      crypto.verify(
        "sha256",
        Buffer.from(message),
        { key: crypto.createPublicKey({ key: jwk!, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        Buffer.from(signed.signature, "base64url"),
      ),
    );
    expect(offline).toBe(true);

    const valid = yield* call<{ valid: boolean }>("POST", "/verify", {
      apiKey,
      body: { message, kid: signed.kid, signature: signed.signature },
    });
    expect(valid.valid).toBe(true);
    const tampered = yield* call<{ valid: boolean }>("POST", "/verify", {
      apiKey,
      body: { message: "ship order 43", kid: signed.kid, signature: signed.signature },
    });
    expect(tampered.valid).toBe(false);
  }),
  { timeout: 600_000 },
);

// Runs last: it retires the stack's API key.
test(
  "rotating the API key retires the old one",
  Effect.gen(function* () {
    const oldKey = yield* initialApiKey;
    const ids = yield* where;

    const rotated = yield* call<{ apiKey: string; version: string }>("POST", "/rotate", {
      apiKey: oldKey,
    });
    expect(rotated.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.apiKey).not.toBe(oldKey);
    // The new value is the secret's latest version in Azure Resource Manager.
    expect(yield* armSecretVersion(ids)).toBe(rotated.version);

    const withOld = yield* call<{ error: string }>("GET", "/jwks", {
      apiKey: oldKey,
      status: 401,
    });
    expect(withOld.error).toBe("missing or wrong x-api-key");
    const withNew = yield* call<{ keys: unknown[] }>("GET", "/jwks", { apiKey: rotated.apiKey });
    expect(withNew.keys).toHaveLength(1);
  }),
  { timeout: 600_000 },
);
