import * as AWS from "alchemy-effect/AWS";
import * as Stack from "alchemy-effect/Stack";
import * as Output from "alchemy-effect/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import WebFleet from "./src/WebFleet.ts";

const aws = AWS.providers().pipe(Layer.provide(AWS.DefaultStageConfig));

export default Effect.gen(function* () {
  const web = yield* WebFleet;

  return {
    albUrl: Output.interpolate`http://${web.albDnsName}`,
    nlbUrl: Output.interpolate`http://${web.nlbDnsName}`,
    enqueueExample: Output.interpolate`http://${web.albDnsName}/enqueue?message=hello`,
    autoScalingGroupName: web.autoScalingGroupName,
  };
}).pipe(Stack.make("AwsEc2Example", aws));
