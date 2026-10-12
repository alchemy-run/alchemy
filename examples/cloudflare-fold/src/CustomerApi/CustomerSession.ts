import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { customer } from "../Actor.ts";
import { CurrentActor } from "../CurrentActor.ts";
import { Unauthorized } from "./Unauthorized.ts";

/**
 * Authenticates a customer request and provides the customer as the
 * {@link CurrentActor}.
 */
export class CustomerSession extends RpcMiddleware.Service<
  CustomerSession,
  { provides: CurrentActor }
>()("Bank/CustomerSession", { error: Unauthorized, requiredForClient: true }) {}

/**
 * Demo verifier: accepts `Authorization: Bearer customer:<id>`. Replace with a
 * JWT or session-cookie verifier in production.
 */
export const CustomerSessionLive = Layer.succeed(CustomerSession, (effect, { headers }) =>
  Option.match(Headers.get(headers, "authorization"), {
    onNone: () => Effect.fail(new Unauthorized()),
    onSome: (value) => {
      const match = /^Bearer customer:(.+)$/.exec(value);
      return match
        ? Effect.provideService(effect, CurrentActor, customer(match[1]!))
        : Effect.fail(new Unauthorized());
    },
  }),
);

/** Client side: attach the customer's token to every request. */
export const customerSessionClient = (token: string) =>
  RpcMiddleware.layerClient(CustomerSession, ({ request, next }) =>
    next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }),
  );
