import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteTanStackStartExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Azure.Website.TanStackStart("Web", {
      // Flex Consumption and Blob static websites are both offered here.
      location: "eastus",
      env: { GREETING: "Hello from TanStack Start on Azure!" },
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "vite.config.ts"],
      },
    });

    return { url: site.url };
  }),
);
