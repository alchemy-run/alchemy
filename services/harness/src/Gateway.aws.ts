import * as Anthropic from "alchemy/Anthropic";
import * as AWS from "alchemy/AWS";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AgentGateway } from "./Gateway.ts";

/**
 * Serves {@link AgentGateway}: the model API key and your GitHub login live
 * here, never in a container. Each request is checked against the rules
 * below and the grant the session's Durable Object minted.
 *
 * A Lambda Web Function, not a Worker: a Worker's requests to github.com
 * share Cloudflare's connections, so one slowly read clone stalls the
 * others. It serves from every Region in `regions`, nearest first.
 */
export default class AgentGatewayAws extends AWS.Lambda.WebFunction<AgentGatewayAws>()(
  "AgentGateway",
  {
    main: import.meta.url,
    authType: "ApplicationManaged",
    regions: ["us-east-1", "eu-west-1", "ap-northeast-1"],
    // A clone, or a model's streamed answer, runs as long as it takes.
    timeout: Duration.minutes(15),
  },
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
