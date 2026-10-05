import * as Alchemy from "alchemy";
import * as Azure from "alchemy/Azure";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteViteExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const web = yield* Azure.Website.Vite("Web", {
      location: "eastus",
      memo: {
        include: ["index.html", "src/**", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: web.url,
    };
  }),
);
