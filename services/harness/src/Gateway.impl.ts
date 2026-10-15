import * as Anthropic from "alchemy/Anthropic";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Gateway } from "./Gateway.ts";

/**
 * {@link Gateway}'s rules and credentials, whichever host serves it
 * (Gateway.aws.ts, Gateway.cf.ts): the model API key and your GitHub login
 * live here, never in a container. Each request is checked against these
 * rules and the grant the session's Durable Object minted.
 */
export const serveGateway = Gateway.serve(
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
);
