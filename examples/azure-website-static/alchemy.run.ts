import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "AzureWebsiteStaticExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Azure.Website.StaticSite("Site", {
      command: "bun run build",
      outdir: "dist",
      errorPage: "404.html",
      location: "eastus",
      memo: { include: ["index.html", "src/**", "public/**", "package.json"] },
      dev: { command: "bun run dev:site" },
    });

    return {
      url: site.url,
    };
  }),
);
