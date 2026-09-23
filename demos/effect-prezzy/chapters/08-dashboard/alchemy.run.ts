import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { Dashboard } from "./src/Dashboard.ts";

export default Alchemy.Stack(
  "Shorty",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers(), Axiom.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const web = yield* Cloudflare.Website.Vite("Web", {
      rootDir: "./web",
      dev: { port: 5173 },
      env: { VITE_API_URL: api.url.as<string>() },
    });

    const dashboard = yield* Dashboard;

    return { api: api.url.as<string>(), web: web.url, dashboard: dashboard.uid };
  }),
);
