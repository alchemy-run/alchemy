import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Viewer from "./src/viewer.ts";

export default Alchemy.Stack(
  "DashboardViewer",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Viewer;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
