import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.path,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}
