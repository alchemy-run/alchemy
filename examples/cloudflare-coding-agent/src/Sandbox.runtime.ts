import * as AI from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";
import { Workspace } from "./Workspace.ts";

/**
 * The container program. Yielding the workspace installs its checkout into
 * the image; Claude Code installs the official Agent SDK (and the unmodified
 * `claude` binary), binds the API key, and serves sessions working in the
 * checkout.
 */
export default Sandbox.make(
  { main: import.meta.url, runtime: "node", image: "node:22-bookworm", instanceType: "standard-1" },
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
      apiKey: yield* Config.Redacted("ANTHROPIC_API_KEY"),
      model: "claude-haiku-4-5-20251001",
      cwd: workspace.workdir,
    });
    return { fetch: yield* AI.serveHarnessHttp(claude) };
  }),
);
