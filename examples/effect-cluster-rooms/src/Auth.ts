import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import { RpcMiddleware } from "effect/rpc";
import * as Schema from "effect/Schema";

export class CurrentUser extends Context.Service<CurrentUser, { readonly name: string }>()(
  "CurrentUser",
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

export class Auth extends RpcMiddleware.Service<Auth, { provides: CurrentUser }>()("Auth", {
  error: Unauthorized,
  requiredForClient: true,
}) {}

export const AuthLive = Layer.succeed(Auth, (effect, { headers }) => {
  const token = headers["x-member"];
  return token
    ? Effect.provideService(effect, CurrentUser, { name: token })
    : Effect.fail(new Unauthorized());
});

export class MemberToken extends Context.Service<MemberToken, string>()("MemberToken") {}

export const AuthClient = RpcMiddleware.layerClient(Auth, ({ request, next }) =>
  Effect.gen(function* () {
    // Read per call: the API provides it for each request.
    const token = yield* Effect.serviceOption(MemberToken);
    return yield* next(
      token._tag === "Some"
        ? { ...request, headers: Headers.set(request.headers, "x-member", token.value) }
        : request,
    );
  }),
);
