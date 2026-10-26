import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteNuxtExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Azure.Website.Nuxt("Web", {
      // Flex Consumption and Blob static websites are both offered here.
      location: "eastus",
      // Only hash the files that affect the build, so unchanged sources
      // skip the Nuxt build (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "server/**",
          "public/**",
          "package.json",
          "nuxt.config.ts",
          "tsconfig.json",
        ],
      },
      // An app setting on the Function, read during SSR and by the API route.
      env: {
        GREETING: "Hello from Nuxt on Azure!",
      },
    });

    return {
      url: site.url,
    };
  }),
);
