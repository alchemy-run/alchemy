import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import NativeEngineWorker from "./native-worker.ts";
import DurableWorkflowWorker from "./worker.ts";

export default (
  state = Cloudflare.state(),
  engine: "durable-object" | "native" = "durable-object",
) =>
  Alchemy.Stack(
    engine === "native" ? "NativeEngineStack" : "DurableWorkflowStack",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const worker = yield* engine === "native" ? NativeEngineWorker : DurableWorkflowWorker;
      return { url: worker.url.as<string>() };
    }),
  );
