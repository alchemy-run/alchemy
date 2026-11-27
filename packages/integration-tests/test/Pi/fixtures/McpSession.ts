import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { McpClient, McpProtocol } from "effect/ai";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Layer from "effect/Layer";
import { Gateway } from "./infra.ts";
import PiMcpWorker from "./McpWorker.ts";
import { Fast } from "./models.ts";
import { Add, AddLive, codemodeSection } from "./tools.ts";

const ModelsLive = AICloudflare.Model(Fast, {
  gateway: Gateway,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});

export class Codes extends AI.McpServer<Codes>()("codes") {}

/**
 * The server is another Worker on the same account, so it is reached
 * through a service binding in place of its public URL.
 */
const CodesLive = Layer.unwrap(
  Effect.map(Cloudflare.Workers.Fetch(PiMcpWorker), (fetch) =>
    Codes.layer(
      McpClient.layerHttp({
        name: "pi-test",
        version: "1.0.0",
        protocol: McpProtocol.v2026_07_28,
        url: "https://codes/mcp",
      }).pipe(
        Layer.provide(
          Layer.effect(
            HttpClient.HttpClient,
            Effect.map(Effect.context<RuntimeContext>(), (context) =>
              HttpClient.make((request) =>
                fetch(request).pipe(
                  Effect.mapError(
                    (cause) =>
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.TransportError({ request, cause }),
                      }),
                  ),
                  Effect.provideContext(context),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);

const HarnessLive = Layer.mergeAll(
  ModelsLive,
  AddLive,
  CodesLive,
  AI.CodeModeAsync.pipe(Layer.provide(AICloudflare.EvalQuickJSWorkerLoader())),
  PiCloudflare.DurableObjectStorage,
).pipe(Layer.provideMerge(Cloudflare.Workers.FetchBinding));

/** The server's tools, as a program reaches them. */
const Programs = AI.CodeMode(Codes);

export default class PiMcpSession extends Cloudflare.DurableObject<PiMcpSession>()(
  "PiMcpSession",
  Effect.gen(function* () {
    const harness = yield* Pi.Harness({ models: [Fast], tools: [Add, Codes, Programs] });

    return Effect.gen(function* () {
      return {
        /** A conversation with every tool, with only the `add` tool, or with the server's tools from programs. */
        create: Effect.fn(function* (name: string, withServer: boolean, programs?: boolean) {
          const conversation = yield* harness.createConversation({
            name,
            tools: programs ? [Programs] : withServer ? [Add, Codes] : [Add],
          });
          return conversation.id;
        }),
        /** The tools the model is offered, by name. */
        tools: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          return (yield* conversation.agent).tools.map((tool) => tool.name).sort();
        }),
        section: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          return codemodeSection((yield* conversation.context).messages) ?? null;
        }),
        addServer: (name: string) => harness.configure(name, { tools: { add: [Codes] } }),
        removeServer: (name: string) => harness.configure(name, { tools: { remove: [Codes] } }),
        prompt: Effect.fn(function* (name: string, text: string, requestId: string) {
          const submission = yield* harness.submit(name, {
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
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
