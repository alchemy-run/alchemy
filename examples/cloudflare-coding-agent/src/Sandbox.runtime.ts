import * as AI from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";
import { Workspace } from "./Workspace.ts";

/**
 * Claude Code inside the container: the server installs the official Agent
 * SDK (and the unmodified `claude` binary) into the image, binds the API key
 * into the container environment, and serves sessions on the container port.
 */
export default Sandbox.make(
  { main: import.meta.url, runtime: "node", environment: Workspace, instanceType: "standard-1" },
  Effect.gen(function* () {
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
      apiKey: yield* Config.Redacted("ANTHROPIC_API_KEY"),
    });
    return { fetch: yield* AI.serveHarnessHttp(claude) };
  }),
);
