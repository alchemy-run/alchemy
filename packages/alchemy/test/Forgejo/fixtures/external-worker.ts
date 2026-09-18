import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Forgejo from "@/Forgejo/index.ts";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { Repository } from "./repository.ts";

// Topic updates require an explicitly supplied repository-admin credential.
export const ExternalToken = Forgejo.ApiToken("ExternalToken", {
  scopes: ["write:repository"],
});

export default class ExternalWorker extends Cloudflare.Worker<ExternalWorker>()(
  "ExternalWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const repo = yield* Repository;
    const token = yield* ExternalToken;
    const client = yield* Forgejo.ReadWriteRepository(repo, {
      token: token.token,
      credentialId: "repository-admin",
    });
    const managed = yield* Forgejo.ReadRepository(repo);
    const validBinding = Forgejo.ReadRepository(repo, {
      token: token.token,
      credentialId: "repository-admin",
    });
    const invalidBinding = Forgejo.ReadRepository(repo, {
      token: Config.Redacted("FORGEJO_TEST_INVALID_TOKEN").pipe(
        Config.withDefault(Redacted.make("invalid-override")),
      ),
      credentialId: "invalid-token",
    });
    // Credential identity must survive a different runtime acquisition order.
    const [external, invalid] = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Effect.all([invalidBinding, validBinding]).pipe(
          Effect.map(([invalid, external]) => [external, invalid] as const),
        )
      : yield* Effect.all([validBinding, invalidBinding]);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method === "POST" && request.url.endsWith("/topics")) {
          yield* client
            .setTopics({ topics: ["external-runtime"] })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json(
            yield* client.getTopics().pipe(Effect.orDie),
          );
        }
        if (request.url.endsWith("/external")) {
          return yield* HttpServerResponse.json(
            yield* external.get().pipe(Effect.orDie),
          );
        }
        if (request.url.endsWith("/invalid")) {
          return yield* invalid.get().pipe(
            Effect.match({
              onSuccess: () => "unexpected success",
              onFailure: (error) => error._tag,
            }),
            Effect.map(HttpServerResponse.text),
          );
        }
        return yield* HttpServerResponse.json(
          yield* managed.get().pipe(Effect.orDie),
        );
      }),
    };
  }).pipe(Effect.provide(Cloudflare.ForgejoBindings)),
) {}
