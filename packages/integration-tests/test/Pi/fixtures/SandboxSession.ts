import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Base, Gateway } from "./infra.ts";
import { Fast } from "./models.ts";

const ModelsLive = Layer.unwrap(
  Effect.map(Cloudflare.AI.QueryGateway(Gateway), (gateway) =>
    Fast.layer(
      gateway.model({
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        parameters: { temperature: 0, maxTokens: 1024 },
      }),
    ),
  ),
);

/**
 * Marks a conversation's sandbox. Conversation ids repeat from one Durable
 * Object to the next, so the object's id is part of the mark.
 */
const markOf = (instanceId: string, conversationId: number) => ({
  "pi-instance": instanceId,
  "pi-conversation": String(conversationId),
});

/** One E2B sandbox per conversation, found again by its mark. */
const SandboxLive = Layer.effect(
  Pi.Sandbox,
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox(Base);
    return Effect.fn(function* ({ instanceId, conversationId }) {
      const metadata = markOf(instanceId, conversationId);
      const [existing] = yield* sandboxes.list({ metadata, state: ["running", "paused"] });
      return existing
        ? yield* sandboxes.connect(existing.sandboxID)
        : yield* sandboxes.create({ metadata, timeout: 600 });
    });
  }),
);

const HarnessLive = Layer.mergeAll(
  ModelsLive,
  PiCloudflare.DurableObjectStorage,
  Pi.SandboxEnv,
).pipe(
  Layer.provide(SandboxLive),
  Layer.provideMerge(Layer.mergeAll(Cloudflare.AI.QueryGatewayBinding, E2B.CreateSandboxHttp)),
);

export default class PiSandboxSession extends Cloudflare.DurableObject<PiSandboxSession>()(
  "PiSandboxSession",
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox(Base);
    const harness = yield* Pi.Harness({ models: [Fast], tools: [Pi.CodingTools] });

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      /** The id of the conversation's sandbox, if it has one. */
      const sandboxIdOf = Effect.fn(function* (name: string) {
        const conversation = yield* harness.conversationByName(name);
        const [found] = yield* sandboxes.list({
          metadata: markOf(state.id.toString(), conversation.id),
          state: ["running", "paused"],
        });
        return found?.sandboxID;
      });

      return {
        create: Effect.fn(function* (name: string) {
          const conversation = yield* harness.createConversation({
            name,
            tools: [Pi.Read, Pi.Write, Pi.Bash],
            instructions: "You work in a Linux sandbox. Use your tools to do what the user asks.",
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
        readFile: Effect.fn(function* (name: string, path: string) {
          const sandboxId = yield* sandboxIdOf(name);
          if (sandboxId === undefined) return null;
          // A sandbox killed a moment ago can still be listed.
          const sandbox = yield* sandboxes
            .connect(sandboxId)
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
          return sandbox === undefined
            ? null
            : yield* sandbox.files.readText(path).pipe(Effect.orElseSucceed(() => null));
        }),
        toolsUsed: Effect.fn(function* (name: string) {
          const conversation = yield* harness.conversationByName(name);
          const { messages } = yield* conversation.context;
          return messages.flatMap((message) =>
            message.role === "toolResult"
              ? [{ tool: message.toolName, isError: message.isError }]
              : [],
          );
        }),
        kill: Effect.fn(function* (name: string) {
          const sandboxId = yield* sandboxIdOf(name);
          if (sandboxId !== undefined) yield* sandboxes.kill(sandboxId);
        }),
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
