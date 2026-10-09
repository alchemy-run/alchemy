import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Path } from "effect/Path";
import SandboxLive from "./src/Sandbox.runtime.ts";
import CodingAgents from "./src/worker.ts";

export default Alchemy.Stack(
  "CloudflareCodingAgent",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* CodingAgents;
    const path = yield* Path;
    // A single-page app for driving the agents, talking to the API above.
    const web = yield* Cloudflare.Website.Vite("Web", {
      rootDir: path.resolve(import.meta.dirname, "web"),
      env: { VITE_API_URL: api.url.as<string>() },
    });
    return { api: api.url.as<string>(), web: web.url.as<string>() };
  }).pipe(Effect.provide(SandboxLive)),
);
