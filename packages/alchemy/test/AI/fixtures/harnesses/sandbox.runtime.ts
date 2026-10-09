import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as AI from "@/AI/index.ts";
import * as Anthropic from "@/Anthropic/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import * as OpenAI from "@/OpenAI/index.ts";
import * as OpenCode from "@/OpenCode/index.ts";
import { Sandbox } from "./sandbox.ts";

/**
 * One image with an environment and three harnesses installed, each served
 * under its own path (`/claude`, `/codex`, `/opencode`). Cheap models only.
 */
export default Sandbox.make(
  {
    main: import.meta.url,
    runtime: "node",
    image: "node:22-bookworm-slim",
    instanceType: "standard-1",
  },
  Effect.gen(function* () {
    // A tiny public repository, checked out into the image at build time.
    const repo = yield* GitHub.MountRepository("octocat/Hello-World", {
      path: "/workspace/hello",
    });
    const anthropicKey = yield* Config.Redacted("ANTHROPIC_API_KEY");
    const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
      apiKey: anthropicKey,
      model: "claude-haiku-4-5-20251001",
      cwd: repo.path,
    });
    const codex = yield* OpenAI.CodexServer("Codex", {
      apiKey: yield* Config.Redacted("OPENAI_API_KEY"),
      model: "gpt-5-nano",
      cwd: repo.path,
    });
    const opencode = yield* OpenCode.Server("OpenCode", {
      env: { ANTHROPIC_API_KEY: anthropicKey },
      model: "anthropic/claude-haiku-4-5",
      cwd: repo.path,
    });
    const routes: Record<
      string,
      Effect.Effect<HttpServerResponse.HttpServerResponse, never, any>
    > = {
      claude: yield* AI.serveHarnessHttp(claude),
      codex: yield* AI.serveHarnessHttp(codex),
      opencode: yield* AI.serveHarnessHttp(opencode),
    };
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const route = routes[new URL(request.url, "http://sandbox").pathname.split("/")[1] ?? ""];
        return route ? yield* route : HttpServerResponse.text("ok");
      }),
    };
  }),
);
