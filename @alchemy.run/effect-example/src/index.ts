import * as Alchemy from "@alchemy.run/effect";
import { State } from "@alchemy.run/effect";
import * as AWS from "@alchemy.run/effect/aws";
import { NodeContext } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ApiLambda } from "./api.ts";

const app = Alchemy.app({ name: "my-iae-app", stage: "dev" });

const aws = AWS.defaultProviders.pipe(
  Layer.provide(AWS.Region.fromEnv),
  Layer.provide(AWS.Credentials.fromChain),
);

const plan = Alchemy.plan({
  phase: process.argv.includes("--destroy") ? "destroy" : "update",
  resources: [
    ApiLambda,
    // Consumer
  ],
}).pipe(Alchemy.approvePlan);

const applied = Alchemy.apply(plan);

const outputs = await applied.pipe(
  Effect.provide(aws),
  Effect.provide(State.localFs),
  Effect.provide(NodeContext.layer),
  Effect.provide(app),
  Effect.catchTag("PlanNotApproved", () => Effect.void),
  Effect.runPromise,
);

if (outputs) {
  const { api, messages } = outputs;
  console.log(api.functionUrl);
  console.log(messages.queueUrl);
}
