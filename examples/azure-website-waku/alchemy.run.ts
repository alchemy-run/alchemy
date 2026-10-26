import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteWakuExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Azure.Website.Waku("WakuSite", {
      // Flex Consumption (the server Function) is offered in eastus.
      location: "eastus",
      // Only hash the files that affect the build, so unchanged sources
      // skip the Waku build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "waku.config.ts"],
      },
      env: {
        GREETING: "Hello from Waku on Azure!",
      },
    });

    return {
      url: site.url,
    };
  }),
);
