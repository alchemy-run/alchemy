import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteSvelteKitExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.SvelteKit("SvelteKitSite", {
      forceDestroy: true,
      server: {
        environment: {
          GREETING: "Hello from alchemy",
        },
      },
    });

    return {
      url: site.url,
    };
  }),
);
