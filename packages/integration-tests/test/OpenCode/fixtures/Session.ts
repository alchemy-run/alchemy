import * as AI from "@alchemy.run/ai";
import * as AIBoat from "@alchemy.run/ai/Boat";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
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

const ModelsLive = AICloudflare.Gateway(Fast, Gateway, {
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});

/** A tagged tool: the contract here, the implementation as a Layer. */
class Add extends AI.Tool<Add>()("add", {
  description: "Add two integers. Always use this tool to add numbers; never add them yourself.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Struct({ sum: Schema.Number }),
}) {}

/** Off by a thousand, so an answer can only come from the tool. */
const AddLive = Add.make(({ a, b }) => ({ sum: a + b + 1000 }));

class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {
  balance: Schema.Number,
}) {}
class AccountFrozen extends Schema.TaggedError<AccountFrozen>()("AccountFrozen", {
  account: Schema.String,
}) {}

/** A tool that fails with one of two declared errors. */
class Withdraw extends AI.Tool<Withdraw>()("withdraw", {
  description: "Withdraw money from an account. Always use this tool to withdraw.",
  parameters: Schema.Struct({ account: Schema.String, amount: Schema.Number }),
  success: Schema.Struct({ balance: Schema.Number }),
  failure: Schema.Union([InsufficientFunds, AccountFrozen]),
}) {}

const WithdrawLive = Withdraw.make(
  Effect.fn(function* ({ account, amount }) {
    if (account === "frozen") return yield* new AccountFrozen({ account });
    if (amount > 137) return yield* new InsufficientFunds({ balance: 137 });
    return { balance: 137 - amount };
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

/** The snapshot every sandbox boots from. */
const Base = Boat.Snapshot("OpenCodeBase", { run: ["node --version"] });

/** Boat finds a sandbox by a label and stops it on `suspend`, keeping its disk. */
const SandboxLive = AIBoat.Sandboxes(Base);

const HarnessLive = Layer.mergeAll(
  ModelsLive,
  AddLive,
  WithdrawLive,
  SandboxLive,
  OpenCode.CodingTools,
  OpenCodeCloudflare.DurableObjectInstance,
).pipe(Layer.provideMerge(Boat.CreateSandboxHttp));

const toolsByName = {
  add: Add,
  withdraw: Withdraw,
  count_bytes: CountBytes,
  bash: AI.Bash,
  read: AI.Read,
};

export default class OpenCodeSession extends Cloudflare.DurableObject<OpenCodeSession>()(
  "OpenCodeSession",
  Effect.gen(function* () {
    const sandboxes = yield* Boat.CreateSandbox(yield* Base);
    const harness = yield* OpenCode.Harness({
      models: [Fast],
      tools: [AI.CodingTools, Add, Withdraw, CountBytes],
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
