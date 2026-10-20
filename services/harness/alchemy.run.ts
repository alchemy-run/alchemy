import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Doppler from "@alchemy.run/doppler";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";
// Each has a host on either cloud: Gateway.cf.ts / Gateway.aws.ts,
// Sandbox.cf.ts / Sandbox.aws.ts.
import GatewayAws from "./src/Gateway.aws.ts";
import { Gateway } from "./src/Gateway.ts";
import SandboxLive from "./src/Sandbox.cf.ts";
import CodingAgents from "./src/Worker.ts";

export default Alchemy.Stack(
  "Harness",
  {
    // AWS: the egress gateway runs on Lambda. GitHub: the gateway resolves
    // your GitHub auth profile's token.
    providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers(), GitHub.providers()),
    state: Alchemy.localState(),
    // ANTHROPIC_API_KEY (read by the gateway) comes from Doppler; an exported
    // variable still overrides it.
    secrets: [Doppler.Secrets({ project: "alchemy-v2", config: "dev" })],
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
    Effect.provide(Layer.mergeAll(SandboxLive, Gateway.host(GatewayAws))),
  ),
);
