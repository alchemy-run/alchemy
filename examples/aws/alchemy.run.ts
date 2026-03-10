import * as AWS from "alchemy-effect/AWS";
import * as Output from "alchemy-effect/Output";
import * as Stack from "alchemy-effect/Stack";
import { Stage } from "alchemy-effect/Stage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import JobFunction from "./src/JobFunction.ts";

const awsConfig = Layer.effect(
  AWS.StageConfig,
  Effect.gen(function* () {
    const stage = yield* Stage;

    if (stage === "prod") {
      // example of how to programatically configure a stage, e.g. hard-code account for prod
      return {
        account: "123456789012",
        region: "us-west-2",
      };
    }

    return yield* AWS.loadDefaultStageConfig();
  }).pipe(Effect.orDie),
);

// const aws = AWS.providers() // <- can also use the default aws stage config by omitting
const aws = AWS.providers().pipe(Layer.provide(awsConfig));

const stack = Effect.gen(function* () {
  const func = yield* JobFunction;
  // const worker = yield* JobWorker;
  return {
    url: Output.interpolate`${func.functionUrl}?jobId=foo`,
    // cloudflareUrl: worker.url,
  };
}).pipe(
  Stack.make(
    "Job",
    Layer.mergeAll(
      // Fully configured cloud provider Layers go here:
      aws,
      // cloudflare,
      // planetscale,
      // et.c
    ),
  ),
);

export default stack;
