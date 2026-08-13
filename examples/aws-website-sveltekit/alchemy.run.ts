import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import Site from "./src/backend.ts";

export default Alchemy.Stack(
  "AwsWebsiteSvelteKitExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    // The Website class (declared in src/backend.ts with its Effect program)
    // is itself the construct — yielding it deploys the site.
    const site = yield* Site;

    return {
      url: site.url,
    };
  }),
);
