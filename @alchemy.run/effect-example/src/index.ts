import * as Alchemy from "@alchemy.run/effect";
import * as AWS from "@alchemy.run/effect-aws";
import * as AlchemyCLI from "@alchemy.run/effect-cli";
import { NodeContext } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ApiLambda } from "./api.ts";

const app = Alchemy.app({ name: "my-iae-app", stage: "dev" });

const aws = AWS.defaultProviders.pipe(
  Layer.provide(AWS.Region.fromEnv),
  Layer.provide(AWS.Credentials.fromChain),
);

const stack = await Alchemy.plan(
  process.argv.includes("--destroy") ? "destroy" : "update",
  ApiLambda,
  // Consumer
).pipe(
  Alchemy.apply,
  Effect.catchTag("PlanRejected", () => Effect.void),
  Effect.provide(AlchemyCLI.review),
  // Effect.provide(AlchemyCLI.reportProgress),
  Effect.provide(aws),
  Effect.provide(Alchemy.State.localFs),
  Effect.provide(NodeContext.layer),
  Effect.provide(app),
  Effect.runPromise,
);

if (stack) {
  console.log(stack.api.functionUrl);
}

export default stack;
