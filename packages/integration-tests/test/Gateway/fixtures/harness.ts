import * as AI from "@alchemy.run/ai";
import * as AIBoat from "@alchemy.run/ai/Boat";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as OpenCode from "@alchemy.run/opencode";
import * as OpenCodeCloudflare from "@alchemy.run/opencode/Cloudflare";
import * as Gateway from "alchemy/Gateway";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Repo } from "./e2b-git.ts";

export const AIGateway = Cloudflare.AI.Gateway("GatewayHarnessAIGateway", { collectLogs: true });

class Fast extends AI.Model<Fast>()("fast") {}

const FastLive = AICloudflare.Model(Fast, {
  gateway: AIGateway,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});

/**
 * A tool handled in the harness (the Durable Object) whose work happens in
 * the session's sandbox: `git push` runs there. The remote the handler
 * gives git is the gateway, so the GitHub token never enters the sandbox.
 */
export class Push extends AI.Tool<Push>()("push", {
  description:
    "Commit a file in the sandbox and push it to a branch of the repository. Always use this tool to push.",
  parameters: Schema.Struct({ branch: Schema.String }),
  success: Schema.Struct({
    exitCode: Schema.Number,
    sha: Schema.String,
    stderr: Schema.String,
    /** The host git pushed to. */
    remote: Schema.String,
    /** Whether anything the sandbox was given or can read looks like a GitHub token. */
    token: Schema.Boolean,
  }),
}) {}

const PushLive = Push.make(
  Effect.gen(function* () {
    const repo = yield* GitHub.PushRepository(Repo);

    return Effect.fn(function* ({ branch }) {
      const sandbox = yield* AI.Sandbox;
      const { url, env } = yield* repo.remote;
      const pushed = yield* sandbox
        .exec(
          [
            "sh",
            "-c",
            [
              "rm -rf pushed",
              `git clone -q --depth 1 "$REMOTE" pushed`,
              "cd pushed",
              `echo "pushed to $BRANCH" > from-a-tool.txt`,
              "git add from-a-tool.txt",
              `git -c user.name=alchemy -c user.email=alchemy@example.com commit -q -m "pushed by a tool"`,
              `git push -q --force "$REMOTE" "HEAD:refs/heads/$BRANCH"`,
              "git rev-parse HEAD",
            ].join(" && "),
          ],
          // Boat stops a command after 30 seconds unless told otherwise.
          { env: { ...env, REMOTE: url, BRANCH: branch }, timeout: 120_000 },
        )
        .pipe(Effect.orDie);
      // Everything the sandbox was given, and what git kept of it.
      const seen = yield* sandbox
        .exec(["sh", "-c", "env; cat pushed/.git/config ~/.gitconfig 2>/dev/null"], { env })
        .pipe(Effect.orDie);
      return {
        exitCode: pushed.exitCode,
        sha: pushed.stdout.trim().split("\n").at(-1) ?? "",
        stderr: pushed.stderr,
        remote: new URL(url).host,
        token: /gh[opsu]_|github_pat_|x-access-token/.test(seen.stdout),
      };
    });
  }),
);

/**
 * The object's gateway, for `GitHub.PushRepository` alone: the model and
 * the sandboxes keep their bindings on the Worker. Provided beneath every
 * other Layer, so each binding is built knowing which side it is on.
 */
const GatewayLive = Gateway.only(GitHub.PushRepository).pipe(
  Layer.provide(Cloudflare.Workers.SandboxGateway),
);

const Base = Boat.Snapshot("GatewayHarnessBase", { run: ["git --version"] });

const HarnessLive = Layer.mergeAll(
  FastLive,
  PushLive,
  OpenCode.CodingTools,
  OpenCodeCloudflare.DurableObjectInstance,
).pipe(
  Layer.provideMerge(AIBoat.Sandboxes(Base)),
  Layer.provideMerge(GitHub.PushRepositoryHttp),
  Layer.provide(GatewayLive),
);

export class HarnessSession extends Cloudflare.DurableObject<HarnessSession>()(
  "GatewayHarnessSession",
  Effect.gen(function* () {
    const harness = yield* OpenCode.Harness({ models: [Fast], tools: [AI.CodingTools, Push] });

    return Effect.succeed({
      prompt: Effect.fn(function* (name: string, text: string) {
        const reply = yield* harness.session(name).prompt(text, { tools: [Push], requestId: name });
        return reply.text;
      }),
      /** Every tool call the session made, as OpenCode names and reports it. */
      toolsUsed: Effect.fn(function* (name: string) {
        const messages = yield* harness.session(name).messages;
        return messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "tool"
              ? [
                  {
                    tool: part.tool,
                    status: part.state?.status,
                    output: part.state?.output ?? part.state?.error ?? "",
                  },
                ]
              : [],
          ),
        );
      }),
      kill: (name: string) => harness.session(name).removeSandbox,
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}

export default class HarnessWorker extends Cloudflare.Worker<HarnessWorker>()(
  "GatewayHarnessWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* HarnessSession;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, name, action] = new URL(request.url, "http://api").pathname.split("/");
        const session = sessions.getByName("main");
        switch (action) {
          case "prompt": {
            const body = (yield* request.json) as { text: string };
            return yield* HttpServerResponse.json({
              text: yield* session.prompt(name!, body.text),
            });
          }
          case "tools":
            return yield* HttpServerResponse.json(yield* session.toolsUsed(name!));
          case "kill":
            yield* session.kill(name!);
            return yield* HttpServerResponse.json({ ok: true });
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
