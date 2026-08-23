import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Site } from "./shared.ts";

/**
 * Effect-native canvas Function. Bundled into one file on the Bun
 * function runtime — no Docker, no registry. Distinct from {@link Api}.
 */
export default class Ping extends Railway.Function<Ping>()(
  "Ping",
  {
    project: Site,
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}
