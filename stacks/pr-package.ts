import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./pr-package/src/Api.ts";
import Redirect from "./pr-package/src/Redirect.ts";

export default Alchemy.Stack(
  "PrPackage",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const redirect = yield* Redirect;
    return {
      url: api.url.as<string>(),
      redirectUrl: redirect.url.as<string>(),
    };
  }),
);
