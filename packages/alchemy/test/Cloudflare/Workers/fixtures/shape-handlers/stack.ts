import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import ShapeScheduledWorker from "./worker.ts";

export default Alchemy.Stack(
  "WorkerShapeHandlersStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* ShapeScheduledWorker;
    return {
      url: worker.url.as<string>(),
      crons: worker.crons,
    };
  }),
);
