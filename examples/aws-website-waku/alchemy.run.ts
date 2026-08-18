import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import Site from "./src/backend.ts";

export default Alchemy.Stack(
  "AwsWebsiteWakuExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    // The Website class (and its Effect program + DynamoDB/SQS bindings)
    // is defined in ./src/backend.ts — yielding it deploys the whole
    // thing: the Waku RSC server on a streaming Lambda, assets in S3
    // behind CloudFront, and the queue consumer on the SAME Lambda
    // (single-handler delivery).
    const site = yield* Site;

    return {
      url: site.url,
    };
  }),
);
