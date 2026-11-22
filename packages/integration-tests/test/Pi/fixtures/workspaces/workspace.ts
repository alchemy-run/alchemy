import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Fast } from "../models.ts";

/** The model on the Worker's own AI binding, with no gateway in between. */
const ModelsLive = AICloudflare.Model(Fast, {
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});

/** Every coding tool as Pi provides it, in a sandbox on the platform of the Layer passed in. */
export const workspace = <E, R>(sandboxes: Layer.Layer<AI.Sandboxes, E, R>) =>
  Effect.gen(function* () {
    const harness = yield* Pi.Harness({ models: [Fast], tools: [AI.CodingTools] });

    return Effect.gen(function* () {
      return {
        create: Effect.fn(function* (name: string) {
          const conversation = yield* harness.createConversation({
            name,
            tools: [AI.Bash, AI.Read, AI.Edit, AI.Write, AI.Grep, AI.Glob],
            instructions:
              "You work in a Linux sandbox. Do exactly what the user asks with the tool they name, then stop.",
          });
          return conversation.id;
        }),
        prompt: Effect.fn(function* (name: string, text: string, requestId: string) {
          const conversation = yield* harness.conversationByName(name);
          const submission = yield* conversation.submit({
            type: "input",
            content: text,
            requestId,
          });
          return (yield* submission.wait).status;
        }),
        results: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          const { messages } = yield* conversation.context;
          return messages.flatMap((message) =>
            message.role === "toolResult"
              ? [
                  {
                    tool: message.toolName,
                    isError: message.isError,
                    text: message.content
                      .map((part) => (part.type === "text" ? part.text : ""))
                      .join(""),
                  },
                ]
              : [],
          );
        }),
        suspend: (name: string) => harness.suspendSandbox(name),
        remove: (name: string) => harness.removeSandbox(name),
      };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ModelsLive,
        PiCloudflare.DurableObjectStorage,
        Pi.CodingTools.pipe(Layer.provideMerge(sandboxes)),
      ),
    ),
  );

/** What a workspace Durable Object answers. */
interface Workspace {
  create(name: string): Effect.Effect<number, unknown, RuntimeContext>;
  prompt(
    name: string,
    text: string,
    requestId: string,
  ): Effect.Effect<string, unknown, RuntimeContext>;
  results(name: string): Effect.Effect<unknown, unknown, RuntimeContext>;
  suspend(name: string): Effect.Effect<unknown, unknown, RuntimeContext>;
  remove(name: string): Effect.Effect<unknown, unknown, RuntimeContext>;
}

/** `/<name>/<action>` on the workspace Durable Object of that name. */
export const api = <E, R>(
  workspaces: Effect.Effect<{ getByName(name: string): Workspace }, E, R>,
) =>
  Effect.gen(function* () {
    const namespace = yield* workspaces;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [, name, action] = url.pathname.split("/");
        if (name === undefined) return HttpServerResponse.text("not found", { status: 404 });
        const workspace = namespace.getByName(name);
        const body =
          request.method === "POST" ? ((yield* request.json) as Record<string, any>) : {};
        switch (action) {
          case "create":
            return yield* HttpServerResponse.json({ id: yield* workspace.create(name) });
          case "prompt":
            return yield* HttpServerResponse.json({
              status: yield* workspace.prompt(name, body.text, body.requestId),
            });
          case "results":
            return yield* HttpServerResponse.json(yield* workspace.results(name));
          case "suspend":
            yield* workspace.suspend(name);
            return yield* HttpServerResponse.json({ ok: true });
          case "remove":
            yield* workspace.remove(name);
            return yield* HttpServerResponse.json({ ok: true });
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(
        // Answer with the failure, so a test can say what went wrong.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  });
