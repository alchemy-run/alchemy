import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { agent } from "../Actor.ts";
import { CurrentActor } from "../CurrentActor.ts";
import { Unauthorized } from "../CustomerApi/Unauthorized.ts";

/** Authenticates a support agent and provides the agent as the {@link CurrentActor}. */
export class SupportAgentSession extends RpcMiddleware.Service<
  SupportAgentSession,
  { provides: CurrentActor }
>()("Bank/SupportAgentSession", { error: Unauthorized, requiredForClient: true }) {}

/**
 * Demo verifier: accepts `Authorization: Bearer agent:<id>`. In production,
 * verify a Cloudflare Access JWT instead.
 */
export const SupportAgentSessionLive = Layer.succeed(SupportAgentSession, (effect, { headers }) =>
  Option.match(Headers.get(headers, "authorization"), {
    onNone: () => Effect.fail(new Unauthorized()),
    onSome: (value) => {
      const match = /^Bearer agent:(.+)$/.exec(value);
      return match
        ? Effect.provideService(effect, CurrentActor, agent(match[1]!))
        : Effect.fail(new Unauthorized());
    },
  }),
);

/** Client side: attach the agent's token to every request. */
export const supportAgentSessionClient = (token: string) =>
  RpcMiddleware.layerClient(SupportAgentSession, ({ request, next }) =>
    next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }),
  );
