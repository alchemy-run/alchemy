import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Site } from "./src/shared.ts";

export default Alchemy.Stack(
  "RailwayWebsiteSolidYieldExample",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Site;
    const api = yield* Api;
    const site = yield* Railway.Website.SolidYield("Web", {
      project,
      // Inlined into the client bundle at build time.
      env: { VITE_API_URL: Output.map(api.url, (url) => url ?? "") },
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the deploy) entirely.
      memo: {
        include: ["src/**", "index.html", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: site.url,
      apiUrl: api.url,
      serviceId: site.service?.serviceId,
    };
  }),
);
