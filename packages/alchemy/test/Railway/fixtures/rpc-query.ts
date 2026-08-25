import { bindService } from "@/Railway/Bind.ts";
import { Function } from "@/Railway/Function.ts";
import { enableRailwayRpc } from "@/Railway/rpc-server.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Api } from "./rpc-api-tag.ts";
import { Site } from "./rpc-shared.ts";

/**
 * Tagged Function that hosts `greet` and binds the tagged {@link Api}
 * Service. Public `fetch` calls `api.ping()` over the private mesh.
 */
export default class Query extends Function<Query>()(
  "Query",
  { project: Site, main: import.meta.url },
  Effect.gen(function* () {
    enableRailwayRpc();
    const api = yield* bindService(Api);
    return {
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      fetch: api
        .ping()
        .pipe(Effect.map((pong) => HttpServerResponse.text(pong))),
    };
  }),
) {}
