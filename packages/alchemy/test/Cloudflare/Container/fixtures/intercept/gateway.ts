import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Egress from "@/Egress/index.ts";

/** Only this gateway's egress answers this host. */
export const EGRESS_HOST = "egress.internal";

/** A custom egress kind: answers every request itself, showing what arrived. */
export interface EchoKind extends Egress.EgressKind<"Echo"> {
  (): Effect.Effect<Egress.ConfiguredEgress<"Echo">>;
}

export const Echo: EchoKind = Object.assign(
  () =>
    Effect.succeed({
      [Egress.ConfiguredEgressTypeId]: "Echo" as const,
      perSubject: false,
      allows: () => Effect.void,
      routes: () => Effect.succeed([{ host: EGRESS_HOST }]),
      handler: () =>
        Effect.succeed((request) =>
          Effect.succeed(
            HttpServerResponse.text(
              `egress ${request.method} ${new URL(request.url).pathname} auth=${request.headers.authorization ?? "-"}`,
            ),
          ),
        ),
      env: {},
      tools: [],
    } satisfies Egress.ConfiguredEgress<"Echo">),
  { [Egress.EgressKindTypeId]: "Echo" as const },
);

export class EchoGateway extends Egress.Gateway<EchoGateway>()("InterceptEchoGateway", {
  echo: Echo,
}) {}
