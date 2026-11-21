import * as AI from "@alchemy.run/ai";
import * as AIBoat from "@alchemy.run/ai/Boat";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Gateway } from "./infra.ts";
import { Fast } from "./models.ts";

const ModelsLive = AICloudflare.Gateway(Fast, Gateway, {
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});

/** The snapshot every sandbox boots from. */
const Base = Boat.Snapshot("PiBase", { run: ["node --version"] });

/** Boat finds a sandbox by a label and stops it on `suspend`, keeping its disk. */
const SandboxLive = AIBoat.Sandboxes(Base);

/** A tool of our own that works in the conversation's sandbox, through `AI.Sandbox`. */
class CountBytes extends AI.Tool<CountBytes>()(
  "count_bytes",
  {
    description:
      "Count the bytes of a file in the sandbox. Use it whenever asked for a file's size.",
    parameters: Schema.Struct({ path: Schema.String }),
    success: Schema.Struct({ bytes: Schema.Number }),
    replay: "safe",
  },
  Effect.gen(function* () {
    return Effect.fn(function* ({ path }) {
      const sandbox = yield* AI.Sandbox;
      const text = yield* sandbox.readTextFile(path).pipe(Effect.orDie);
      return { bytes: new TextEncoder().encode(text).length };
    });
  }),
) {}

const HarnessLive = Layer.mergeAll(
  ModelsLive,
  PiCloudflare.DurableObjectStorage,
  Pi.CodingTools.pipe(Layer.provideMerge(SandboxLive)),
).pipe(Layer.provideMerge(Boat.CreateSandboxHttp));

export default class PiSandboxSession extends Cloudflare.DurableObject<PiSandboxSession>()(
  "PiSandboxSession",
  Effect.gen(function* () {
    const sandboxes = yield* Boat.CreateSandbox(yield* Base);
    const harness = yield* Pi.Harness({ models: [Fast], tools: [AI.CodingTools, CountBytes] });

    return Effect.gen(function* () {
      /** The conversation's sandbox as Boat lists it, if it has one. */
      const sandboxOf = Effect.fn(function* (name: string) {
        const conversation = yield* harness.conversationByName(name);
        const [found] = yield* sandboxes.list({ labels: { key: conversation.sandboxKey } });
        return found;
      });

      return {
        create: Effect.fn(function* (name: string) {
          const conversation = yield* harness.createConversation({
            name,
            tools: [AI.Read, AI.Write, AI.Bash, CountBytes],
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
          const sandboxId = (yield* sandboxOf(name))?.id;
          if (sandboxId === undefined) return null;
          const sandbox = yield* sandboxes.connect(sandboxId);
          return yield* sandbox.files.readText(path).pipe(Effect.orElseSucceed(() => null));
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
        /** The sandbox's state on Boat: `running`, `paused` (stopped, disk kept), or `null` when it has none. */
        sandboxState: Effect.fn(function* (name: string) {
          const state = (yield* sandboxOf(name))?.state;
          if (state === undefined) return null;
          return state === "archiving" || state === "archived" ? "paused" : "running";
        }),
        suspend: (name: string) => harness.suspendSandbox(name),
        kill: (name: string) => harness.removeSandbox(name),
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
