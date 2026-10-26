import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteReactRouterExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Azure.Website.ReactRouter("Web", {
      location: "eastus",
      env: { GREETING: "Hello from React Router on Azure!" },
      // Only hash the files that affect the build, so unchanged sources
      // skip the React Router build (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "public/**",
          "package.json",
          "react-router.config.ts",
          "vite.config.ts",
        ],
      },
    });

    return { url: site.url };
  }),
);
