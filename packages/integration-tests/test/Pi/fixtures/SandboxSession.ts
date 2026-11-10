import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Gateway } from "./infra.ts";
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

/** One E2B sandbox per conversation, found again by its metadata. */
const SandboxEnvLive = Pi.SandboxEnv(
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox();
    return Effect.fn(function* ({ conversationId }) {
      const metadata = { "pi-conversation": String(conversationId) };
      const [existing] = yield* sandboxes.list({ metadata, state: ["running", "paused"] });
      return existing
        ? yield* sandboxes.connect(existing.sandboxID)
        : yield* sandboxes.create({ metadata, timeout: 600 });
    });
  }),
);

const HarnessLive = Layer.mergeAll(
  ModelsLive,
  SandboxEnvLive,
  PiCloudflare.DurableObjectStorage,
).pipe(
  Layer.provideMerge(Layer.mergeAll(Cloudflare.AI.QueryGatewayBinding, E2B.CreateSandboxHttp)),
);

export default class PiSandboxSession extends Cloudflare.DurableObject<PiSandboxSession>()(
  "PiSandboxSession",
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox();
    const harness = yield* Pi.Harness({ models: [Fast], tools: [Pi.CodingTools] });

    /** The conversation's sandbox, for checking its files out of band. */
    const sandboxOf = Effect.fn(function* (name: string) {
      const conversation = yield* harness.conversationByName(name);
      const [found] = yield* sandboxes.list({
        metadata: { "pi-conversation": String(conversation.id) },
        state: ["running", "paused"],
      });
      return found === undefined ? undefined : yield* sandboxes.connect(found.sandboxID);
    });

    return Effect.gen(function* () {
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
          const sandbox = yield* sandboxOf(name);
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
          const sandbox = yield* sandboxOf(name);
          if (sandbox !== undefined) yield* sandbox.kill();
        }),
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
