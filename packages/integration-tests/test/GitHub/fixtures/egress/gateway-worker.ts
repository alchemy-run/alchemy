import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import { GitHubEgressGateway } from "./gateway.ts";
import { EGRESS_REPO } from "./repo.ts";

/** Write access to the test repository (agent branches only), with the profile's token. */
export default class GitHubEgressGatewayWorker extends Cloudflare.Worker<GitHubEgressGatewayWorker>()(
  "GitHubEgressGatewayWorker",
  { main: import.meta.url },
  GitHubEgressGateway.serve(
    Effect.gen(function* () {
      return {
        repo: yield* GitHub.Egress({
          token: GitHub.ProfileToken,
          repositories: [
            {
              repository: EGRESS_REPO,
              contents: "write",
              pullRequests: "write",
              issues: "write",
              push: { branches: ["agent/**"] },
            },
          ],
        }),
      };
    }),
  ),
) {}
