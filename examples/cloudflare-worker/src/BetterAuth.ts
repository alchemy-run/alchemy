import * as Cloudflare from "alchemy-effect/Cloudflare";
import type { HttpEffect } from "alchemy-effect/Http";
import { betterAuth, type Auth } from "better-auth";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class BetterAuth extends ServiceMap.Service<
  BetterAuth,
  {
    auth: Effect.Effect<Auth<any>>;
    fetch: HttpEffect<Cloudflare.WorkerEnvironment | Cloudflare.WorkerServices>;
  }
>()("BetterAuth") {}

export const BetterAuthLive = Layer.effect(
  BetterAuth,
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1Database("BetterAuth");

    const connect = yield* Cloudflare.D1Connection.bind(d1);

    // const betterAuthSecret = yield* Alchemy.makeRandom("BETTER_AUTH_SECRET");

    const auth = yield* Effect.gen(function* () {
      return betterAuth({
        database: yield* connect.raw,
        secret: "FOO",
      });
    }).pipe(Effect.cached);

    return {
      auth,
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const authInstance = yield* auth;
        const response = yield* Effect.promise(() =>
          authInstance.handler(request.source as Request),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }),
).pipe(Layer.provide(Cloudflare.D1.D1ConnectionLive));
