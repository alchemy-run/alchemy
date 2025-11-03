import * as AWS from "@alchemy.run/aws";
import * as AlchemyCLI from "@alchemy.run/cli";
import * as Alchemy from "@alchemy.run/core";
import { FetchHttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { Api } from "./src/index.ts";

const phase = process.argv.includes("--destroy") ? "destroy" : "update";

const plan = Alchemy.plan({
  phase: process.argv.includes("--destroy") ? "destroy" : "update",
  services: [Api],
});

const stack = await plan.pipe(
  // Effect.tap((plan) => Console.log(plan)),
  Alchemy.apply,
  Effect.provide(AlchemyCLI.layer),
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
