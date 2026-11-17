import { customer } from "@cluster-bank/domain/Actor";
import { CurrentActor } from "@cluster-bank/domain/CurrentActor.context";
import { Session, Unauthorized } from "@cluster-bank/domain/Session.middleware";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * The {@link Session} middleware: the customer a request is from, by its
 * `x-customer` header.
 *
 * Demo only: anyone may act as any customer. Verify a signed session (a
 * cookie, a bearer token) here before trusting who the request says it is.
 */
export const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-customer"), {
    onNone: () => Effect.fail(new Unauthorized()),
    onSome: (id) => Effect.provideService(effect, CurrentActor, customer(id)),
  }),
);
