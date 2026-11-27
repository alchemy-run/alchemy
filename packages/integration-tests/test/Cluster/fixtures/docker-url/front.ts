/** Calls the entity through the pool's gateway, from Postgres's network. */
import * as Docker from "@alchemy.run/docker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Network } from "./cluster.ts";
import UrlEcho from "./echo.ts";

export default class UrlFront extends Docker.Service<UrlFront>()(
  "ClusterUrlFront",
  Effect.gen(function* () {
    const network = yield* Network;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ internal: 3000 }],
      networks: [{ name: network.name }],
    };
  }),
  Effect.gen(function* () {
    const echoes = yield* UrlEcho;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const text = new URL(request.url, "http://front").pathname.split("/")[2] ?? "x";
        const echo = yield* echoes.getByName(text);
        return yield* HttpServerResponse.json({ value: yield* echo.Say({ text }) });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
