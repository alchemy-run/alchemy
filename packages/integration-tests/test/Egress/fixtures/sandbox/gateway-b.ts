import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import { GatewayB, REPO_B } from "./gateways.ts";
import { tagged } from "./tagged.ts";

/** Serves {@link GatewayB}: reads {@link REPO_B} with the profile's token. */
export default class GatewayBWorker extends Cloudflare.Worker<GatewayBWorker>()(
  "SandboxEgressGatewayBWorker",
  { main: import.meta.url },
  GatewayB.serve(
    Effect.gen(function* () {
      return {
        repo: yield* GitHub.Egress({
          token: GitHub.ProfileToken,
          repositories: [{ repository: REPO_B, contents: "read" }],
        }),
      };
    }),
  ).pipe(Effect.map(tagged("B"))),
) {}
