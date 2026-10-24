import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Egress from "alchemy/Egress";
import * as Effect from "effect/Effect";
import { DRIP_HOST, GatewayA, REPO_A } from "./gateways.ts";
import { tagged } from "./tagged.ts";

/** Serves {@link GatewayA}: reads {@link REPO_A} with the profile's token, and drips. */
export default class GatewayAWorker extends Cloudflare.Worker<GatewayAWorker>()(
  "SandboxEgressGatewayAWorker",
  { main: import.meta.url },
  GatewayA.serve(
    Effect.gen(function* () {
      return {
        repo: yield* GitHub.Egress({
          token: GitHub.ProfileToken,
          repositories: [{ repository: REPO_A, contents: "read" }],
        }),
        drip: yield* Egress.Http({
          credential: { host: DRIP_HOST, paths: ["/drip"], headers: {} },
        }),
      };
    }),
  ).pipe(Effect.map(tagged("A"))),
) {}
