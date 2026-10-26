import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteVinextExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Azure.Website.Vinext("Web", {
      // Flex Consumption and Blob static websites are both offered here.
      location: "eastus",
      env: { GREETING: "Hello from vinext on a Function!" },
      // Only hash the files that affect the build, so unchanged sources
      // skip the vinext build (and the deploy) entirely.
      memo: {
        include: ["app/**", "public/**", "package.json", "vite.config.ts", "tsconfig.json"],
      },
    });

    return { url: site.url };
  }),
);
