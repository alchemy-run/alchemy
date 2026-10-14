import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import DurableWorkflowWorker from "./worker.ts";

export default (state = Cloudflare.state()) =>
  Alchemy.Stack(
    "DurableWorkflowStack",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const worker = yield* DurableWorkflowWorker;
      return { url: worker.url.as<string>() };
    }),
  );
