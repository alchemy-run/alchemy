import * as AWS from "alchemy-effect/AWS";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ServiceFunction from "./src/ServiceFunction.ts";

const aws = AWS.providers().pipe(Layer.provide(AWS.DefaultStageConfig));

export default Effect.gen(function* () {
  yield* ServiceFunction;
}).pipe(Stack.make("AwsRdsExample", aws));
