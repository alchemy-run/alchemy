import * as AI from "@alchemy.run/ai";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as OpenCode from "@alchemy.run/opencode";
import * as OpenCodeCloudflare from "@alchemy.run/opencode/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Gateway } from "./infra.ts";

/** Llama 3.3 70B reliably returns OpenAI-shaped tool calls on Workers AI. */
class Fast extends AI.Model<Fast>()("fast") {}

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

/** A tagged tool: the contract here, the implementation as a Layer. */
class Add extends AI.Tool<Add>()("add", {
  description: "Add two integers. Always use this tool to add numbers; never add them yourself.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Struct({ sum: Schema.Number }),
}) {}

/** Off by a thousand, so an answer can only come from the tool. */
const AddLive = Add.make(
  Effect.gen(function* () {
    return Effect.fn(function* ({ a, b }) {
      return { sum: a + b + 1000 };
    });
  }),
);

/** A tool of our own that works in the session's sandbox, through `AI.Sandbox`. */
class CountBytes extends AI.Tool<CountBytes>()(
  "count_bytes",
  {
    description:
      "Count the bytes of a file in the sandbox. Use it whenever asked for a file's size.",
    parameters: Schema.Struct({ path: Schema.String }),
    success: Schema.Struct({ bytes: Schema.Number }),
  },
  Effect.gen(function* () {
    return Effect.fn(function* ({ path }) {
      const sandbox = yield* AI.Sandbox;
      const text = yield* sandbox.readTextFile(path).pipe(Effect.orDie);
      return { bytes: new TextEncoder().encode(text).length };
    });
  }),
) {}

/** The sandbox client, bound to the snapshot every session's sandbox boots from. */
const Sandboxes = Effect.gen(function* () {
  const base = yield* Boat.Snapshot("OpenCodeBase", { run: ["node --version"] });
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

const HarnessLive = Layer.mergeAll(
  ModelsLive,
  AddLive,
  SandboxLive,
  OpenCodeCloudflare.DurableObjectInstance,
).pipe(
  Layer.provideMerge(Layer.mergeAll(Cloudflare.AI.QueryGatewayBinding, Boat.CreateSandboxHttp)),
);

const toolsByName = { add: Add, count_bytes: CountBytes, bash: OpenCode.Bash, read: OpenCode.Read };

export default class OpenCodeSession extends Cloudflare.DurableObject<OpenCodeSession>()(
  "OpenCodeSession",
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    const harness = yield* OpenCode.Harness({
      models: [Fast],
      tools: [OpenCode.CodingTools, Add, CountBytes],
    });

    return Effect.gen(function* () {
      /** The session's sandbox as Boat lists it, if it has one. */
      const sandboxOf = Effect.fn(function* (name: string) {
        const [found] = yield* sandboxes.list({
          labels: { key: harness.session(name).sandboxKey },
        });
        return found;
      });

      return {
        /** Prompt with exactly `tools`; answers with the reply's text. */
        prompt: Effect.fn(function* (
          name: string,
          text: string,
          tools: ReadonlyArray<keyof typeof toolsByName>,
          requestId: string,
        ) {
          const reply = yield* harness
            .session(name)
            .prompt(text, { tools: tools.map((tool) => toolsByName[tool]), requestId });
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
        readFile: Effect.fn(function* (name: string, path: string) {
          const sandboxId = (yield* sandboxOf(name))?.id;
          if (sandboxId === undefined) return null;
          const sandbox = yield* sandboxes.connect(sandboxId);
          return yield* sandbox.files.readText(path).pipe(Effect.orElseSucceed(() => null));
        }),
        /** The sandbox's state on Boat: `running`, `paused` (stopped, disk kept), or `null` when it has none. */
        sandboxState: Effect.fn(function* (name: string) {
          const state = (yield* sandboxOf(name))?.state;
          if (state === undefined) return null;
          return state === "archiving" || state === "archived" ? "paused" : "running";
        }),
        suspend: (name: string) => harness.session(name).suspendSandbox,
        kill: (name: string) => harness.session(name).removeSandbox,
      };
    });
  }).pipe(Effect.provide(HarnessLive)),
) {}
