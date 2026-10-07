import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "AwsWebsiteSolidYieldExample",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    // The client build in S3 behind CloudFront. `spa` defaults on, so
    // unmatched paths answer with the index page (200).
    const site = yield* AWS.Website.SolidYield("Web", {
      // Inlined into the client bundle at build time.
      env: { VITE_API_URL: api.functionUrl.as<string>() },
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "index.html", "package.json", "vite.config.ts"],
      },
      forceDestroy: true,
    });

    return {
      url: site.url,
      apiUrl: api.functionUrl,
    };
  }),
);
