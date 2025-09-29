import path from "node:path";

import * as AlchemyCLI from "@alchemy.run/effect-cli";
import { NodeContext } from "@effect/platform-node";
import * as Effect from "effect/Effect";

import * as Alchemy from "@alchemy.run/effect";
import * as AWS from "@alchemy.run/effect-aws";
import * as Lambda from "@alchemy.run/effect-aws/lambda";
import * as SQS from "@alchemy.run/effect-aws/sqs";

import { api, Messages } from "./src/index.ts";

// TODO(sam): combine this with Alchemy.plan to do it all in one-line
const app = Alchemy.app({ name: "my-iae-app", stage: "dev" });

const src = path.join(import.meta.dirname, "src");

const stack = await Alchemy.plan({
  phase: process.argv.includes("--destroy") ? "destroy" : "update",
  resources: [
    Lambda.make(api, {
      main: path.join(src, "api.ts"),
      policy: Alchemy.bound(SQS.SendMessage(Messages)),
    }),
    // Consumer
    // Lambda.make(consumer, {
    //   main: path.join(src, "consumer-handler.ts"),
    //   policy: Alchemy.bound(SQS.Consume(Messages)),
    // }),
  ],
}).pipe(
  Alchemy.apply,
  Effect.catchTag("PlanRejected", () => Effect.void),
  Effect.provide(AlchemyCLI.layer),
  Effect.provide(AWS.layer),
  Effect.provide(Alchemy.dotAlchemy),
  Effect.provide(Alchemy.State.localFs),
  Effect.provide(NodeContext.layer),
  Effect.provide(app),
  Effect.runPromise,
);

if (stack) {
  console.log(stack.api.functionUrl);
}

export default stack;
