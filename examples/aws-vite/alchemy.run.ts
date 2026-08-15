import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import Site from "./src/backend.ts";

export default Alchemy.Stack(
  "AwsViteExample",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    // The Website class (declared in src/backend.ts with its Effect
    // program) is itself the construct — yielding it deploys the Vite
    // build, the CloudFront edge, the backend Lambda, the DynamoDB table,
    // and the SQS queue + consumer mapping.
    const site = yield* Site;

    return {
      url: site.url,
      // The backend Lambda's Function URL — in dev, the local emulator
      // address the frontend proxies /api/* to.
      serverUrl: site.serverUrl,
    };
  }),
);
