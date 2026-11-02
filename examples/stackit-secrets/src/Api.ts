import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { Puller, registryFor } from "./registry.ts";
import { API_KEY_PATH, DataKey, Vault } from "./resources.ts";

/** Constant-time comparison, so response timing doesn't leak the key. */
const sameKey = (expected: string, given: string | undefined) => {
  if (given === undefined || given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  }
  return diff === 0;
};

/**
 * Encryption as a service. Callers send plaintext and get back KMS ciphertext, and the
 * reverse, without holding key material. Every route needs the `x-api-key` from Secrets
 * Manager.
 *
 * - `POST /encrypt` takes `{ plaintext }` and returns `{ ciphertext, version }`.
 * - `POST /decrypt` takes `{ ciphertext, version }` and returns `{ plaintext }`.
 */
export default class Api extends Stackit.Functions.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    const puller = yield* Puller;
    const registry = yield* registryFor("api");
    return {
      main: import.meta.url,
      registry,
      pullCredential: puller.pullCredentialId,
    };
  }),
  Effect.gen(function* () {
    const secrets = yield* Stackit.SecretsManager.ReadSecret(yield* Vault);
    const dataKey = yield* DataKey;
    const encrypt = yield* Stackit.KMS.Encrypt(dataKey);
    const decrypt = yield* Stackit.KMS.Decrypt(dataKey);

    /** Vault holds the key, and the function reads the latest version on each call. */
    const authorized = (request: HttpServerRequest) =>
      secrets.get({ secretPath: API_KEY_PATH }).pipe(
        Effect.map(({ data }) => {
          const expected = data.data.value;
          return sameKey(
            Redacted.isRedacted(expected) ? Redacted.value(expected) : String(expected),
            request.headers["x-api-key"],
          );
        }),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://function");

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }
        if (request.method !== "POST") {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        if (!(yield* authorized(request))) {
          return yield* HttpServerResponse.json({ error: "invalid api key" }, { status: 401 });
        }

        if (url.pathname === "/encrypt") {
          const { plaintext } = (yield* request.json) as { plaintext: string };
          const encrypted = yield* encrypt({
            plaintext: Redacted.make(new TextEncoder().encode(plaintext)),
          });
          return yield* HttpServerResponse.json({
            ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
            version: encrypted.version,
          });
        }

        if (url.pathname === "/decrypt") {
          const body = (yield* request.json) as { ciphertext: string; version: number };
          const decrypted = yield* decrypt({
            ciphertext: Buffer.from(body.ciphertext, "base64"),
            version: body.version,
          });
          return yield* HttpServerResponse.json({
            plaintext: new TextDecoder().decode(Redacted.value(decrypted.plaintext)),
          });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide([
      Stackit.SecretsManager.ReadSecretHttp,
      Stackit.KMS.EncryptHttp,
      Stackit.KMS.DecryptHttp,
    ]),
  ),
) {}
