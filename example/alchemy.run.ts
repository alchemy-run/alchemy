import { FetchHttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import * as Alchemy from "alchemy-effect";
import * as AWS from "alchemy-effect/aws";
import { Layer } from "effect";
import * as Effect from "effect/Effect";
import { Api } from "./src/index.ts";

const plan = Alchemy.plan({
  phase: process.argv.includes("--destroy") ? "destroy" : "update",
  services: [Api],
});

const app = Alchemy.app({ name: "my-app", stage: "dev" });

const providers = Layer.provideMerge(
  Layer.mergeAll(AWS.live, Alchemy.State.localFs, Alchemy.CLI.layer),
  Layer.mergeAll(app, Alchemy.dotAlchemy),
);

const layers = Layer.provideMerge(
  providers,
  Layer.mergeAll(NodeContext.layer, FetchHttpClient.layer),
);

const stack = await plan.pipe(
  // Effect.tap((plan) => Console.log(plan)),
  Alchemy.apply,
  Effect.provide(layers),
  Effect.tap((stack) => Effect.log(stack?.Api.functionUrl)),
  Effect.runPromise,
);

if (stack) {
  console.log(stack.Api.functionUrl);
}
