import * as AI from "@alchemy.run/ai";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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

/** The sandbox client, bound to the snapshot every conversation's sandbox boots from. */
const Sandboxes = Effect.gen(function* () {
  const base = yield* Boat.Snapshot("PiBase", { run: ["node --version"] });
  return yield* Boat.CreateSandbox(base);
});

/** Boat finds a sandbox by a label and stops it on `suspend`, keeping its disk. */
const SandboxLive = Layer.effect(
  AI.Sandboxes,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    const find = (key: string) => sandboxes.list({ labels: { key } });
    return {
      open: Effect.fn(function* (key) {
        const [existing] = yield* find(key);
        if (existing === undefined) {
          return yield* sandboxes.create({
            type: "small",
            noEnv: true,
            autoStop: "10 minutes",
            labels: { key },
          });
        }
        const sandbox = yield* sandboxes.connect(existing.id);
        yield* sandbox.resume({ autoStop: "10 minutes" });
        return sandbox;
      }),
      suspend: Effect.fn(function* (key) {
        const [existing] = yield* find(key);
        if (existing === undefined) return;
        const sandbox = yield* sandboxes.connect(existing.id);
        yield* sandbox.stop();
      }),
      remove: Effect.fn(function* (key) {
        const found = yield* find(key);
        yield* Effect.forEach(found, (sandbox) => sandboxes.delete(sandbox.id));
      }),
    };
  }),
);

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
  Pi.CodingToolsLive.pipe(Layer.provideMerge(SandboxLive)),
).pipe(
  Layer.provideMerge(Layer.mergeAll(Cloudflare.AI.QueryGatewayBinding, Boat.CreateSandboxHttp)),
);

export default class PiSandboxSession extends Cloudflare.DurableObject<PiSandboxSession>()(
  "PiSandboxSession",
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
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
