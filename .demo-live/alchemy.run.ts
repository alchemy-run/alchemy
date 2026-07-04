import * as Alchemy from "../packages/alchemy/src/index.ts";
import * as Cloudflare from "../packages/alchemy/src/Cloudflare/index.ts";
import { localState } from "../packages/alchemy/src/State/LocalState.ts";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "DashboardLive",
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* () {
    const cache = yield* Cloudflare.KV.Namespace("cache");
    const jobs = yield* Cloudflare.Queues.Queue("jobs");
    const api = yield* Cloudflare.Worker("api", {
      main: "./worker.ts",
      env: {
        CACHE: cache,
        JOBS: jobs,
      },
    });
    return { url: api.url };
  }),
);
