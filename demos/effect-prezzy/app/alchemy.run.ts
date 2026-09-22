import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "Shorty",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;

    const dashboard = yield* Cloudflare.Website.Vite("Dashboard", {
      rootDir: "./web",
      env: { VITE_API_URL: api.url.as<string>() },
    });

    return { api: api.url, dashboard: dashboard.url };
  }),
);
