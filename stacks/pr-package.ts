import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./pr-package/src/Api.ts";
import { AuthTokenValue } from "./pr-package/src/AuthToken.ts";

export default Alchemy.Stack(
  "PrPackage",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const authToken = yield* AuthTokenValue;
    return {
      url: api.url.as<string>(),
      authToken: authToken.text,
    };
  }),
);
