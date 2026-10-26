import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteNextjsExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Azure.Website.Nextjs("Web", {
      // Flex Consumption and Blob static websites are both offered here.
      location: "eastus",
      // Only hash the files that affect the build, so unchanged sources
      // skip `next build` (and the deploy) entirely.
      memo: {
        include: [
          "app/**",
          "public/**",
          "package.json",
          "next.config.mjs",
          "postcss.config.mjs",
          "tsconfig.json",
        ],
      },
      // An app setting on the Function, read by the page at request time.
      env: {
        GREETING: "Hello from Next.js on Azure!",
      },
    });

    return {
      url: site.url,
    };
  }),
);
