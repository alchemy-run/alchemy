import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AwsWebsiteAstroExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.Astro("Astro", {
      // Only hash the files that affect the build, so unchanged sources
      // skip the Astro build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "astro.config.ts"],
      },
      forceDestroy: true,
      server: {
        environment: {
          GREETING: "Hello from Alchemy!",
        },
      },
    });

    return {
      url: site.url,
    };
  }),
);
