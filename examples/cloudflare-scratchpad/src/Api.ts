import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class Simple extends Cloudflare.Worker<Simple>()(
  "Simple",
  {
    main: import.meta.path,
    observability: {
      enabled: true,
    },
    compatibility: {
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("Hello World");
      }),
    };
  }),
) {}
