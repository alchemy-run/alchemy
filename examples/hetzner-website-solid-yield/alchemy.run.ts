import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Box } from "./src/shared.ts";

export default Alchemy.Stack(
  "HetznerWebsiteSolidYieldExample",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // The API unit and the site's static server share one Server.
    const server = yield* Box;
    const api = yield* Api;
    const site = yield* Hetzner.Website.SolidYield("Web", {
      server,
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
      serverId: server.serverId,
      ipv4: server.ipv4,
    };
  }),
);
