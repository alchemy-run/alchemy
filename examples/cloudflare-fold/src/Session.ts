import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { agent, customer } from "./Actor.ts";
import { CurrentActor } from "./CurrentActor.ts";
import { Unauthorized } from "./Unauthorized.ts";

/**
 * Authenticates a request, from a customer or a support agent, and provides
 * who is making it as the {@link CurrentActor}. Authorization is up to each
 * command's `decide` and each view's `validate`.
 */
export class Session extends RpcMiddleware.Service<Session, { provides: CurrentActor }>()(
  "Bank/Session",
  { error: Unauthorized, requiredForClient: true },
) {}

/**
 * Demo verifier: accepts `Authorization: Bearer customer:<id>` or
 * `Authorization: Bearer agent:<id>`. In production, verify a session cookie
 * for customers and a Cloudflare Access JWT for agents.
 */
export const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(Headers.get(headers, "authorization"), {
    onNone: () => Effect.fail(new Unauthorized()),
    onSome: (value) => {
      const match = /^Bearer (customer|agent):(.+)$/.exec(value);
      if (!match) return Effect.fail(new Unauthorized());
      const actor = match[1] === "customer" ? customer(match[2]!) : agent(match[2]!);
      return Effect.provideService(effect, CurrentActor, actor);
    },
  }),
);

/** Client side: send this token with every request. */
export const sessionClient = (token: string) =>
  RpcMiddleware.layerClient(Session, ({ request, next }) =>
    next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }),
  );
