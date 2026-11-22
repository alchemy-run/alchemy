import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Gateway } from "./infra.ts";
import { Fast } from "./models.ts";
import { Add, AddLive, Withdraw, WithdrawLive } from "./tools.ts";

const ModelsLive = AICloudflare.Model(Fast, {
  gateway: Gateway,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});

/** Effect code mode, in an isolate loaded for the scripts. */
const HarnessLive = Layer.mergeAll(
  ModelsLive,
  AddLive,
  WithdrawLive,
  Pi.CodeModeEffect.pipe(Layer.provide(PiCloudflare.EvalWorkerLoader())),
  PiCloudflare.DurableObjectStorage,
);

export default class PiEffectSession extends Cloudflare.DurableObject<PiEffectSession>()(
  "PiEffectSession",
  Effect.gen(function* () {
    const harness = yield* Pi.Harness({
      models: [Fast],
      tools: [Add, Withdraw],
      extensions: [Pi.CodeMode],
    });

    return Effect.gen(function* () {
      return {
        create: Effect.fn(function* (name: string) {
          const conversation = yield* harness.createConversation({
            name,
            tools: [Add, Withdraw],
            instructions: "You are terse. Use your tools whenever they apply.",
          });
          yield* conversation.configure({ extensions: { add: [Pi.CodeMode] } });
          return conversation.id;
        }),
        prompt: Effect.fn(function* (name: string, text: string, requestId: string) {
          const conversation = yield* harness.conversationByName(name);
          const submission = yield* conversation.submit({
            type: "input",
            content: text,
            requestId,
          });
          const settled = yield* submission.wait;
          return { status: settled.status };
        }),
        toolResults: Effect.fn(function* (name: string) {
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
