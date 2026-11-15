import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { TestRegistry } from "../../fixtures/app/shared.ts";

export const AppSecret = DigitalOcean.Security.Secret("AppSecret", {
  values: { GREETING: Redacted.make("hello from a secret") },
});

/** Reads a value of the bound secret. */
export default class SecretApp extends DigitalOcean.App<SecretApp>()(
  "SecretApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    const secret = yield* AppSecret;
    const read = yield* DigitalOcean.Security.ReadSecret(secret);
    return {
      fetch: Effect.gen(function* () {
        const greeting = yield* read.get("GREETING");
        return HttpServerResponse.text(Redacted.value(greeting));
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(DigitalOcean.Security.ReadSecretHttp)),
) {}
