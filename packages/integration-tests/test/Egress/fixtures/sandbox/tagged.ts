import type { GatewayServer } from "alchemy/Egress";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { GATEWAY_HEADER } from "./gateways.ts";

/** A gateway that names itself on every response, so a test can tell where a request landed. */
export const tagged = (name: string) => (server: GatewayServer) => ({
  ...server,
  fetch: server.fetch.pipe(
    Effect.map((response) => HttpServerResponse.setHeader(response, GATEWAY_HEADER, name)),
  ),
});
