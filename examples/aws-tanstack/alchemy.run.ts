import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import Site from "./src/backend.ts";

export default Alchemy.Stack(
  "AwsTanstackExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    // The Website class (and its Effect program + DynamoDB/SQS bindings)
    // is defined in ./src/backend.ts — yielding it deploys the whole
    // thing: the TanStack Start server on a streaming Lambda, assets in
    // S3 behind CloudFront, and the queue consumer as a sibling Lambda.
    const website = yield* Site;

    return {
      url: website.url,
    };
  }),
);
