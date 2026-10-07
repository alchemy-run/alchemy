import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "FlyWebsiteSolidYieldExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const site = yield* Fly.Website.SolidYield("Web", {
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
      appName: site.app?.appName,
      apiAppName: api.appName,
    };
  }),
);
