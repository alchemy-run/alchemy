import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Hard-coded values the integ test asserts against to prove the
 * deploy-time bindings flow all the way through to the runtime.
 */
export const LITERAL_SECRET_VALUE = "sk-literal-secret-abc";
export const STRING_VAR_VALUE = "plain-string-value";
export const NUMBER_VAR_VALUE = 4242;
export const OBJECT_VAR_VALUE = { host: "localhost", flags: { beta: true } };

/**
 * Name of the deploy-time `process.env` variable the test populates
 * before deploying — sourced via `Config.string(...)` inside the
 * worker's init phase.
 */
export const CONFIG_SECRET_ENV_KEY = "ALCHEMY_SECRET_TEST_SOURCE";

export default class SecretsTestWorker extends Cloudflare.Worker<SecretsTestWorker>()(
  "SecretsTestWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
  },
  Effect.gen(function* () {
    // Secret from a literal — `Alchemy.Secret` coerces the literal to
    // `Redacted` and the Worker provider deploys it as `secret_text`.
    const literalSecret = yield* Alchemy.Secret(
      "LITERAL_SECRET",
      LITERAL_SECRET_VALUE,
    );

    // Secret from a `Config` — resolved against the active
    // `ConfigProvider` (process.env) at deploy time.
    const configSecret = yield* Alchemy.Secret(
      "CONFIG_SECRET",
      Config.string(CONFIG_SECRET_ENV_KEY),
    );

    // Plain string variable — `plain_text` binding round-trip.
    const stringVar = yield* Alchemy.Variable("STRING_VAR", STRING_VAR_VALUE);

    // Number variable — non-string values JSON.stringify on `set` and
    // JSON.parse on the runtime accessor, so the accessor returns the
    // original number.
    const numberVar = yield* Alchemy.Variable("NUMBER_VAR", NUMBER_VAR_VALUE);

    // Object variable — same JSON round-trip as above for nested data.
    const objectVar = yield* Alchemy.Variable("OBJECT_VAR", OBJECT_VAR_VALUE);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `request.url` on Cloudflare workers is the pathname+query
        // (relative). Use `originalUrl` to get the absolute URL so
        // `new URL(...)` doesn't throw.
        const pathname = new URL(request.originalUrl).pathname;
        switch (pathname) {
          case "/secret/literal": {
            const value = yield* literalSecret;
            return yield* HttpServerResponse.json({
              isRedacted: Redacted.isRedacted(value),
              value: Redacted.value(value),
            });
          }
          case "/secret/config": {
            const value = yield* configSecret;
            return yield* HttpServerResponse.json({
              isRedacted: Redacted.isRedacted(value),
              value: Redacted.value(value),
            });
          }
          case "/var/string": {
            const value = yield* stringVar;
            return yield* HttpServerResponse.json({
              type: typeof value,
              value,
            });
          }
          case "/var/number": {
            const value = yield* numberVar;
            return yield* HttpServerResponse.json({
              type: typeof value,
              value,
            });
          }
          case "/var/object": {
            const value = yield* objectVar;
            return yield* HttpServerResponse.json({
              type: typeof value,
              value,
            });
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }),
) {}
