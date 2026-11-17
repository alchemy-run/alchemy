import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
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

/** The sandbox client, bound to the image every conversation's sandbox boots from. */
const Sandboxes = Effect.gen(function* () {
  const base = yield* E2B.Template("PiBase", { image: "node:22-bookworm" });
  return yield* E2B.CreateSandbox(base);
});

/** E2B finds a sandbox by its metadata and pauses it on `suspend`. */
const SandboxLive = Layer.effect(
  AI.Sandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    const find = (key: string) =>
      sandboxes.list({ metadata: { key }, state: ["running", "paused"] });
    return {
      open: Effect.fn(function* (key) {
        const [existing] = yield* find(key);
        return existing
          ? yield* sandboxes.connect(existing.sandboxID, { timeout: 600 })
          : yield* sandboxes.create({ metadata: { key }, timeout: 600 });
      }),
      suspend: Effect.fn(function* (key) {
        const [existing] = yield* find(key);
        if (existing?.state !== "running") return;
        const sandbox = yield* sandboxes.connect(existing.sandboxID);
        yield* sandbox.pause();
      }),
      remove: Effect.fn(function* (key) {
        const found = yield* find(key);
        yield* Effect.forEach(found, (sandbox) => sandboxes.kill(sandbox.sandboxID));
      }),
    };
  }),
);

/** A tool of our own that works in the conversation's sandbox, through `Pi.Env`. */
class CountBytes extends Pi.Tool<CountBytes>()(
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
      const env = yield* Pi.Env;
      const text = yield* env.readTextFile(path).pipe(Effect.orDie);
      return { bytes: new TextEncoder().encode(text).length };
    });
  }),
) {}

const HarnessLive = Layer.mergeAll(ModelsLive, PiCloudflare.DurableObjectStorage, SandboxLive).pipe(
  Layer.provideMerge(Layer.mergeAll(Cloudflare.AI.QueryGatewayBinding, E2B.CreateSandboxHttp)),
);

export default class PiSandboxSession extends Cloudflare.DurableObject<PiSandboxSession>()(
  "PiSandboxSession",
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    const harness = yield* Pi.Harness({ models: [Fast], tools: [Pi.CodingTools, CountBytes] });

    return Effect.gen(function* () {
      /** The conversation's sandbox as E2B lists it, if it has one. */
      const sandboxOf = Effect.fn(function* (name: string) {
        const conversation = yield* harness.conversationByName(name);
        const [found] = yield* sandboxes.list({
          metadata: { key: conversation.sandboxKey },
          state: ["running", "paused"],
        });
        return found;
      });

      return {
        create: Effect.fn(function* (name: string) {
          const conversation = yield* harness.createConversation({
            name,
            tools: [Pi.Read, Pi.Write, Pi.Bash, CountBytes],
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
          const sandboxId = (yield* sandboxOf(name))?.sandboxID;
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
        /** The sandbox's state on E2B: `running`, `paused`, or `null` when it has none. */
        sandboxState: Effect.fn(function* (name: string) {
          return (yield* sandboxOf(name))?.state ?? null;
        }),
        suspend: (name: string) => harness.suspendSandbox(name),
        kill: (name: string) => harness.removeSandbox(name),
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
