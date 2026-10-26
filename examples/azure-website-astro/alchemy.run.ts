import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteAstroExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Azure.Website.Astro("Astro", {
      // Flex Consumption (the server Function) is offered in eastus.
      location: "eastus",
      // Only hash the files that affect the build, so unchanged sources
      // skip the Astro build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "astro.config.ts"],
      },
      env: {
        GREETING: "Hello from Astro on Azure!",
      },
    });

    return {
      url: site.url,
    };
  }),
);
