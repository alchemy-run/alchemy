import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteVocsExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Azure.Website.Vocs("VocsDocs", {
      // Flex Consumption (the server Function) is offered in eastus.
      location: "eastus",
      memo: {
        include: ["src/**", "public/**", "package.json", "vocs.config.ts"],
      },
    });

    return {
      url: site.url,
    };
  }),
);
