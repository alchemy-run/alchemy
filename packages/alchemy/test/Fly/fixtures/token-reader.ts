import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import * as Fly from "@/Fly";

export const VAULT_SECRET_NAME = "TOKEN_READER_SECRET";

export const Vault = Fly.App("Vault");

export const VaultSecret = Fly.Secret("VaultSecret", {
  app: Vault,
  name: VAULT_SECRET_NAME,
  value: Redacted.make("hello-from-the-vault"),
});

/**
 * Service in its own App that reads a Secret on another App with the org
 * token, so the token must reach the Machine. Fly refuses `show_secrets`
 * across Apps, so it lists the other App's secrets (metadata only).
 */
export default class TokenReader extends Fly.Service<TokenReader>()(
  "TokenReader",
  {
    main: import.meta.url,
    region: "iad",
    port: 3000,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const list = yield* Fly.ListSecrets(Vault);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/secret")) {
          return yield* list().pipe(
            Effect.flatMap(({ secrets }) =>
              HttpServerResponse.json({ names: (secrets ?? []).map((secret) => secret.name) }),
            ),
            Effect.catch((error) =>
              HttpServerResponse.json({ error: String(error) }, { status: 500 }),
            ),
          );
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Fly.ListSecretsHttp)),
) {}
