import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteOctaneExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Azure.Website.Octane("Web", {
      location: "eastus",
      env: { GREETING: "Hello from Octane on Azure!" },
      // Only hash the files that affect the build, so unchanged sources
      // skip the Octane build (and the deploy) entirely.
      memo: {
        include: [
          "src/**",
          "public/**",
          "index.html",
          "package.json",
          "octane.config.ts",
          "vite.config.ts",
        ],
      },
    });

    return { url: site.url };
  }),
);
