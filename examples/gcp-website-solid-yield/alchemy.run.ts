import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "GcpWebsiteSolidYieldExample",
  {
    providers: GCP.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const site = yield* GCP.Website.SolidYield("Web", {
      // Inlined into the client bundle at build time.
      env: { VITE_API_URL: api.uri.as<string>() },
      // Only hash the files that affect the build, so unchanged sources
      // skip the Vite build (and the image rebuild) entirely.
      memo: {
        include: ["src/**", "index.html", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: site.url,
      apiUrl: api.uri,
    };
  }),
);
