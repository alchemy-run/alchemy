import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import DurableWorkflowWorker from "./worker.ts";
import EffectWorkflowsWorker from "./workflows-worker.ts";

export default (
  state = Cloudflare.state(),
  engine: "durable-objects" | "workflows" = "durable-objects",
) =>
  Alchemy.Stack(
    engine === "workflows" ? "EffectWorkflowsStack" : "DurableWorkflowStack",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const worker = yield* engine === "workflows" ? EffectWorkflowsWorker : DurableWorkflowWorker;
      return { url: worker.url.as<string>() };
    }),
  );
