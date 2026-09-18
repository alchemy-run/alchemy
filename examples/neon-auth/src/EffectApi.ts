import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { auth, branch } from "./resources.ts";

export default class EffectApi extends Neon.Function<EffectApi>()(
  "EffectAuthApi",
  Effect.gen(function* () {
    return { branch: yield* branch, main: import.meta.url };
  }),
  Effect.gen(function* () {
    const connection = yield* Neon.ConnectAuth(auth);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith("Bearer "))
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        const baseUrl = yield* connection.baseUrl;
        const jwksUrl = yield* connection.jwksUrl;
        const verification = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(
              authorization.slice(7),
              createRemoteJWKSet(new URL(jwksUrl)),
              { issuer: new URL(baseUrl).origin },
            ),
          catch: () => new Error("Invalid or expired token"),
        }).pipe(
          Effect.match({
            onSuccess: (value) => value.payload,
            onFailure: () => undefined,
          }),
        );
        if (!verification?.sub)
          return HttpServerResponse.text("Invalid or expired token", {
            status: 401,
          });
        return yield* HttpServerResponse.json({
          userId: verification.sub,
          email: verification.email,
        });
      }),
    };
  }).pipe(Effect.provide(Neon.ConnectAuthHttp)),
) {}
