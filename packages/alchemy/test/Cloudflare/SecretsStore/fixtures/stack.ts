import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import AsyncSecretWorker from "./worker.ts";

export default Alchemy.Stack(
  "AsyncSecretBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* AsyncSecretWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
