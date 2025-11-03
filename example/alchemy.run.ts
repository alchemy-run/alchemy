import { FetchHttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import * as Alchemy from "alchemy-effect";
import * as AWS from "alchemy-effect/aws";
import * as Effect from "effect/Effect";
import { Api } from "./src/index.ts";

const plan = Alchemy.plan({
  phase: process.argv.includes("--destroy") ? "destroy" : "update",
  services: [Api],
});

const stack = await plan.pipe(
  // Effect.tap((plan) => Console.log(plan)),
  Alchemy.apply,
  Effect.provide(Alchemy.CLI.layer),
  Effect.provide(AWS.live),
  Effect.provide(Alchemy.State.localFs),
  Effect.provide(Alchemy.dotAlchemy),
  Effect.provide(Alchemy.app({ name: "my-app", stage: "dev" })),
  Effect.provide(NodeContext.layer),
  Effect.provide(FetchHttpClient.layer),
  Effect.tap((stack) => Effect.log(stack?.Api.functionUrl)),
  Effect.runPromise,
);

if (stack) {
  console.log(stack.Api.functionUrl);
}
