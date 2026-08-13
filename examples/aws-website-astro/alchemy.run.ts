import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import Site from "./site.ts";

export default Alchemy.Stack(
  "AwsWebsiteAstroExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    // The Website class (declared in site.ts with its Effect program) is
    // itself the construct — yielding it deploys the site.
    const site = yield* Site;

    return {
      url: site.url,
    };
  }),
);
