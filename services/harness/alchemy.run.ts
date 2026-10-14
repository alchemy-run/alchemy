import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";
import { AgentGateway } from "./src/gateway.ts";
import AgentGatewayWorker from "./src/gateway.worker.ts";
import SandboxLive from "./src/Sandbox.runtime.ts";
import CodingAgents from "./src/worker.ts";

export default Alchemy.Stack(
  "Harness",
  {
    // GitHub: the gateway resolves your GitHub auth profile's token.
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* CodingAgents;
    const path = yield* Path;
    // A single-page app for driving the agents, talking to the API above.
    const web = yield* Cloudflare.Website.Vite("Web", {
      rootDir: path.resolve(import.meta.dirname, "web"),
      env: { VITE_API_URL: api.url.as<string>() },
    });
    return { api: api.url.as<string>(), web: web.url.as<string>() };
  }).pipe(
    // The sandbox's host, and the Worker that serves its egress gateway.
    Effect.provide(Layer.mergeAll(SandboxLive, AgentGateway.host(AgentGatewayWorker))),
  ),
);
