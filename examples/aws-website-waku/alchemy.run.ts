import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteWakuExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.Waku("WakuSite", {
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
