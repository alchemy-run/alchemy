import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "CloudflareWorkerPairedDOExample",
  {
    providers: Cloudflare.providers(),
  },
  Effect.gen(function* () {
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
    };
  }),
);
