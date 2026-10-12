import * as AI from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

/**
 * One coding-agent session per Durable Object (the DO name is the session
 * id), serving the standard `AI.SessionRpcs` contract.
 *
 * The session's container holds no credentials: the model API key and your
 * GitHub login are added to its requests by this Durable Object's egress,
 * which also decides what it may reach. Its history lives in this Durable
 * Object, and its filesystem is snapshotted when the container shuts down,
 * so the session picks up where it left off.
 */
export class Agent extends Cloudflare.RpcDurableObject<Agent>()(
  "Agent",
  { schema: AI.SessionRpcs },
  Effect.gen(function* () {
    const model = yield* Anthropic.Egress(Sandbox, {
      apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
    });
    const github = yield* GitHub.Egress(Sandbox, {
      // Your `gh` login (the stack's GitHub auth profile), never in the container.
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
      ],
    });
    const harness = yield* Cloudflare.Containers.Harness(Sandbox);
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.sync(() =>
      AI.makeSessionHandlers({
        id: state.id.name ?? state.id.toString(),
        harness: harness.start({ egress: [model, github], instance: "standard-4" }),
      }),
    );
  }),
) {}
