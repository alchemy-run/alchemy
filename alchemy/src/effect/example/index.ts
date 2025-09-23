import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWS from "../aws/index.ts";
import * as Alchemy from "../index.ts";
import * as State from "../state.ts";

import { ApiLambda } from "./api.ts";

const app = Alchemy.app({ name: "my-iae-app", stage: "dev" });

const aws = AWS.defaultProviders.pipe(
  Layer.provide(AWS.Region.fromEnv),
  Layer.provide(AWS.Credentials.fromChain.pipe(Layer.tap(Console.log))),
);

const plan = Alchemy.plan({
  phase: process.argv.includes("--destroy") ? "destroy" : "update",
  resources: [
    ApiLambda,
    // Consumer
  ],
});

const applied = Alchemy.apply(plan);

const stack = await applied.pipe(
  Effect.provide(aws),
  Effect.provide(State.inMemory),
  Effect.provide(app),
  Effect.runPromise,
);

if (stack) {
  const { api, messages } = stack;
  console.log(api.functionUrl);
  console.log(messages.queueUrl);
}
