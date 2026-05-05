import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { MyDb } from "./src/db.ts";

export default Alchemy.Stack(
  "CloudflareHyperdriveExample",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const db = yield* MyDb

    return {
      url: api.url.as<string>(),
      hyperdriveId: db.hyperdriveId
    };
  }),
);
