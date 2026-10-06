import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";

export default Alchemy.Stack(
  "DevCliKillFixture",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("KillFixtureWorker", {
      main: "./worker.ts",
    });
    return { workerUrl: worker.url.as<string>() };
  }),
);
