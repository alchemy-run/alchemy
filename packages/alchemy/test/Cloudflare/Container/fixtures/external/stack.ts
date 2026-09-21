import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import ExternalContainerWorker from "./worker.ts";

export default Alchemy.Stack(
  "ExternalContainerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* ExternalContainerWorker;
    return { url: worker.url.as<string>() };
  }),
);
