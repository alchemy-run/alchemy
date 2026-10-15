import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";
import AgentGatewayAws from "./src/Gateway.aws.ts";
import { AgentGateway } from "./src/Gateway.ts";
import SandboxLive from "./src/Sandbox.runtime.ts";
import CodingAgents from "./src/Worker.ts";

export default Alchemy.Stack(
  "Harness",
  {
    // AWS: the egress gateway runs on Lambda. GitHub: the gateway resolves
    // your GitHub auth profile's token.
    providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers(), GitHub.providers()),
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
    // The sandbox's host, and the Web Function that serves its egress gateway.
    Effect.provide(Layer.mergeAll(SandboxLive, AgentGateway.host(AgentGatewayAws))),
  ),
);
