import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import AlarmCallbackWorker from "./worker.ts";

export default Alchemy.Stack(
  "AlarmCallbackStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* AlarmCallbackWorker;
    return { url: worker.url.as<string>() };
  }),
);
