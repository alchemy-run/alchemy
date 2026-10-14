import * as Anthropic from "alchemy/Anthropic";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { AgentGateway } from "./gateway.ts";

/**
 * Serves {@link AgentGateway}: the model API key and your GitHub login live
 * here, never in a container. Each request is checked against the rules
 * below and the grant the session's Durable Object minted.
 */
export default class AgentGatewayWorker extends Cloudflare.Worker<AgentGatewayWorker>()(
  "AgentGateway",
  { main: import.meta.url },
  AgentGateway.serve(
    Effect.gen(function* () {
      return {
        model: yield* Anthropic.Egress({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") }),
        repo: yield* GitHub.Egress({
          // Your `gh` login (the stack's GitHub auth profile).
          token: GitHub.ProfileToken,
          repositories: [
            {
              repository: "alchemy-run/alchemy",
              contents: "write",
              pullRequests: "write",
              issues: "write",
              // The agent pushes its own branches, never main.
              push: { branches: ["agent/**"] },
            },
            // Its generated SDKs: a submodule, read only.
            { repository: "alchemy-run/distilled", contents: "read" },
          ],
        }),
      };
    }),
  ),
) {}
