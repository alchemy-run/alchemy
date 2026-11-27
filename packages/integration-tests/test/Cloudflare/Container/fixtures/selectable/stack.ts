import { declareDurableObjectApplication } from "@alchemy.run/cloudflare/Containers/DurableObjectApplication";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import BunBoxLive from "./bun.ts";
import { BunBox, NodeBox } from "./containers.ts";
import NodeBoxLive from "./node.ts";
import { SelectableStorage } from "./storage.ts";
import { SelectableWorker } from "./worker.ts";

/** A Worker whose Durable Object picks one of two Effect-native Containers per request. */
export const selectableStack = Effect.gen(function* () {
  const worker = yield* SelectableWorker;
  return {
    worker,
    bun: yield* BunBox.Application,
    node: yield* NodeBox.Application,
    application: yield* declareDurableObjectApplication(worker, "Selector"),
    storage: yield* SelectableStorage,
  };
}).pipe(Effect.provide(Layer.mergeAll(BunBoxLive, NodeBoxLive)));
