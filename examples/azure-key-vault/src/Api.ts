import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ApiKey, DataKey, MAX_PLAINTEXT_BYTES, SigningKey } from "./resources.ts";

const json = (body: unknown, status = 200) => HttpServerResponse.json(body, { status });

/** The version segment of a key identifier (`…/keys/{name}/{version}`). */
const versionOf = (kid: string | undefined) => kid?.split("/").pop() ?? "";

const sha256 = (data: string) => createHash("sha256").update(data).digest();

/** Compare two strings in constant time (hashing first evens out their lengths). */
const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

/**
 * Encryption and signing as a service on Azure Functions (Flex Consumption),
 * with every key and secret kept in Azure Key Vault.
 *
 * - `POST /encrypt` `{ plaintext }` — encrypt with `DataKey`, `{ ciphertext }`.
 * - `POST /decrypt` `{ ciphertext }` — decrypt with `DataKey`, `{ plaintext }`.
 * - `POST /sign` `{ message }` — sign with `SigningKey`, `{ kid, alg, signature }`.
 * - `POST /verify` `{ message, kid, signature }` — check a signature, `{ valid }`.
 * - `GET /jwks` — the public half of `SigningKey` as a JSON Web Key Set.
 * - `POST /rotate` — write a new `ApiKey` version, `{ apiKey, version }`.
 *
 * Every route except `GET /` needs the latest `ApiKey` version in the
 * `x-api-key` header, else it answers `401`. A Key Vault error answers `503`
 * with its tag, so a caller can retry while the app's role assignments
 * propagate after a deploy.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const apiKeySecret = yield* ApiKey;
    const dataKey = yield* DataKey;
    const signingKey = yield* SigningKey;

    const apiKey = yield* Azure.KeyVault.SecretReadWrite(apiKeySecret);
    const encrypt = yield* Azure.KeyVault.Encrypt(dataKey);
    const decrypt = yield* Azure.KeyVault.Decrypt(dataKey);
    const sign = yield* Azure.KeyVault.Sign(signingKey);
    const verify = yield* Azure.KeyVault.Verify(signingKey);
    const signingKeyRead = yield* Azure.KeyVault.KeyRead(signingKey);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const route = `${request.method} ${url.pathname}`;

        if (route === "GET /") {
          return HttpServerResponse.text("ok");
        }

        // The latest version of the secret, read on every request, so a
        // rotation takes effect at once without a redeploy.
        const expected = yield* apiKey.get();
        const presented = request.headers["x-api-key"] ?? "";
        const authorized = yield* Effect.sync(() =>
          sameSecret(presented, Redacted.value(expected)),
        );
        if (!authorized) {
          return yield* json({ error: "missing or wrong x-api-key" }, 401);
        }

        const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as Record<
          string,
          unknown
        >;

        switch (route) {
          case "POST /encrypt": {
            if (typeof body.plaintext !== "string") {
              return yield* json({ error: "expected { plaintext: string }" }, 400);
            }
            const plaintext = Buffer.from(body.plaintext, "utf8");
            if (plaintext.length > MAX_PLAINTEXT_BYTES) {
              return yield* json({ error: `plaintext is over ${MAX_PLAINTEXT_BYTES} bytes` }, 400);
            }
            const result = yield* encrypt({
              alg: "RSA-OAEP-256",
              value: plaintext.toString("base64url"),
            });
            // The key version travels with the ciphertext: decrypt needs
            // the version that encrypted it, even after the key rotates.
            return yield* json({ ciphertext: `${versionOf(result.kid)}.${result.value}` });
          }

          case "POST /decrypt": {
            const [keyVersion, value] =
              typeof body.ciphertext === "string" ? body.ciphertext.split(".") : [];
            if (!keyVersion || !value) {
              return yield* json({ error: "expected { ciphertext: string }" }, 400);
            }
            const result = yield* decrypt({ alg: "RSA-OAEP-256", keyVersion, value });
            const plaintext = Buffer.from(result.value ?? "", "base64url").toString("utf8");
            return yield* json({ plaintext });
          }

          case "POST /sign": {
            if (typeof body.message !== "string") {
              return yield* json({ error: "expected { message: string }" }, 400);
            }
            const digest = yield* Effect.sync(() =>
              sha256(body.message as string).toString("base64url"),
            );
            const result = yield* sign({ alg: "ES256", value: digest });
            return yield* json({ kid: result.kid, alg: "ES256", signature: result.value });
          }

          case "POST /verify": {
            const { message, kid, signature } = body;
            if (
              typeof message !== "string" ||
              typeof kid !== "string" ||
              typeof signature !== "string"
            ) {
              return yield* json(
                { error: "expected { message: string, kid: string, signature: string }" },
                400,
              );
            }
            const digest = yield* Effect.sync(() => sha256(message).toString("base64url"));
            const result = yield* verify({
              alg: "ES256",
              keyVersion: versionOf(kid),
              digest,
              value: signature,
            });
            return yield* json({ valid: result.value === true });
          }

          case "GET /jwks": {
            const bundle = yield* signingKeyRead.get();
            // Key Vault never returns private key material; pick the
            // public members explicitly anyway.
            const { kid, kty, crv, x, y } = bundle.key ?? {};
            return yield* json({ keys: [{ kid, kty, crv, x, y, alg: "ES256", use: "sig" }] });
          }

          case "POST /rotate": {
            const next = yield* Effect.sync(() => randomBytes(32).toString("hex"));
            const written = yield* apiKey.set(Redacted.make(next), { contentType: "text/plain" });
            return yield* json({ apiKey: next, version: written.version });
          }

          default:
            return yield* json({ error: "not found" }, 404);
        }
      }).pipe(
        // Every Key Vault error is a typed tag. Answer it with a 503 so a
        // caller sees which one (e.g. while a role assignment propagates).
        Effect.catch((error) => json({ error: error._tag }, 503)),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.KeyVault.SecretReadWriteHttp,
        Azure.KeyVault.EncryptHttp,
        Azure.KeyVault.DecryptHttp,
        Azure.KeyVault.SignHttp,
        Azure.KeyVault.VerifyHttp,
        Azure.KeyVault.KeyReadHttp,
      ),
    ),
  ),
) {}
