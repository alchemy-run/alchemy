/** RPC middleware: the caller's token, checked on the runner, becomes the current user. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import { RpcMiddleware } from "effect/rpc";
import * as Schema from "effect/Schema";

/** The user a message was sent by, for handlers. */
export class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  "CurrentUser",
) {}

/** The caller's token, for the client side of the middleware. */
export class CallerToken extends Context.Service<CallerToken, string>()("CallerToken") {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

export class Auth extends RpcMiddleware.Service<Auth, { provides: CurrentUser }>()("Auth", {
  error: Unauthorized,
  requiredForClient: true,
}) {}

/** Runs on the runner, around every message to an RPC that uses `Auth`. */
export const AuthLive = Layer.succeed(Auth, (effect, { headers }) => {
  const token = headers["x-caller-token"];
  return token?.startsWith("user:")
    ? Effect.provideService(effect, CurrentUser, { id: token.slice("user:".length) })
    : Effect.fail(new Unauthorized());
});

/** Runs in the caller: puts the caller's token, when it has one, on each request. */
export const AuthClient = RpcMiddleware.layerClient(Auth, ({ request, next }) =>
  Effect.gen(function* () {
    const token = yield* Effect.serviceOption(CallerToken);
    return yield* next(
      token._tag === "Some"
        ? { ...request, headers: Headers.set(request.headers, "x-caller-token", token.value) }
        : request,
    );
  }),
);
