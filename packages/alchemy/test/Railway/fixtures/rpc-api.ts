import { bindFunction } from "@/Railway/Bind.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Api } from "./rpc-api-tag.ts";
import Query from "./rpc-query.ts";
import { canPushRailwayImage, railwayRegistry } from "./registry.ts";
import { Site } from "./rpc-shared.ts";

export { Api };

/**
 * Tagged Service that hosts `ping` and binds the tagged {@link Query}
 * Function. Public `fetch` calls `query.greet("sam")` over the private mesh.
 */
export const ApiLive = Api.make(
  {
    project: Site,
    main: import.meta.url,
    port: 3000,
    registry: canPushRailwayImage
      ? railwayRegistry
      : (railwayRegistry ?? "ghcr.io/example"),
  },
  Effect.gen(function* () {
    const query = yield* bindFunction(Query);
    return {
      ping: () => Effect.succeed("pong"),
      fetch: query
        .greet("sam")
        .pipe(Effect.map((greeting) => HttpServerResponse.text(greeting))),
    };
  }),
);

export default Api;
