import * as AI from "alchemy/AI";
import * as Anthropic from "alchemy/Anthropic";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

/**
 * The container program. Mounting the repository checks it out into the
 * image; Claude Code installs the official Agent SDK (and the unmodified
 * `claude` binary), binds the API key, and serves sessions working in the
 * checkout.
 */
export default Sandbox.make(
  { main: import.meta.url, runtime: "node", image: "node:22-bookworm", instanceType: "standard-1" },
  Effect.gen(function* () {
    // The repository agents work in, checked out into the image.
    const repo = yield* GitHub.MountRepository("octocat/Hello-World", { path: "/workspace/hello" });
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
      apiKey: yield* Config.Redacted("ANTHROPIC_API_KEY"),
      model: "claude-haiku-4-5-20251001",
      cwd: repo.path,
    });
    return { fetch: yield* AI.serveHarnessHttp(claude) };
  }),
);
