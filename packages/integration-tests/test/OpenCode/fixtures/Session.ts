import * as AI from "@alchemy.run/ai";
import * as AIBoat from "@alchemy.run/ai/Boat";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as OpenCode from "@alchemy.run/opencode";
import * as OpenCodeCloudflare from "@alchemy.run/opencode/Cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { McpClient, McpProtocol } from "effect/ai";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Gateway } from "./infra.ts";
import OpenCodeMcpWorker from "./McpWorker.ts";

/** Llama 3.3 70B reliably returns OpenAI-shaped tool calls on Workers AI. */
class Fast extends AI.Model<Fast>()("fast") {}

const ModelsLive = AICloudflare.Model(Fast, {
  gateway: Gateway,
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

/** A tool that takes long enough for its prompt to be stopped while it runs. */
const Stall = AI.Tool(
  "stall",
  {
    description:
      "Wait for a build to finish. Always use this tool when asked to wait for the build.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ done: Schema.Boolean }),
  },
  Effect.fn(function* () {
    yield* Effect.sleep("40 seconds");
    return { done: true };
  }),
);

/** A skill whose instructions hold a word the model cannot guess. */
class Releasing extends AI.Skill<Releasing>()("releasing", {
  description: "How to cut a release of this project. Load it before releasing.",
  instructions: "To release, say the release codeword to the operator. The codeword is PLUM-4417.",
}) {}

/** The snapshot every sandbox boots from. */
const Base = Boat.Snapshot("OpenCodeBase", { run: ["node --version"] });

/** Boat finds a sandbox by a label and stops it on `suspend`, keeping its disk. */
const SandboxLive = AIBoat.Sandboxes(Base);

/** An MCP server, on another Worker of the same account. */
class Codes extends AI.McpServer<Codes>()("codes") {}

const CodesLive = Layer.unwrap(
  Effect.map(Cloudflare.Workers.Fetch(OpenCodeMcpWorker), (fetch) =>
    Codes.layer(
      McpClient.layerHttp({
        name: "opencode-test",
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
  WithdrawLive,
  CodesLive,
  OpenCode.CodingTools,
  OpenCodeCloudflare.DurableObjectStorage,
).pipe(
  // The coding tools and the harness's own sandbox tools work in Boat sandboxes.
  Layer.provideMerge(SandboxLive),
  Layer.provideMerge(Layer.mergeAll(Boat.CreateSandboxHttp, Cloudflare.Workers.FetchBinding)),
);

const toolsByName = {
  add: Add,
  withdraw: Withdraw,
  count_bytes: CountBytes,
  stall: Stall,
  bash: AI.Bash,
  read: AI.Read,
  codes: Codes,
};

/**
 * A session over one harness. Each Durable Object below provides how its
 * harness's programs are written and where they run.
 */
const session = Effect.gen(function* () {
  const sandboxes = yield* Boat.CreateSandbox(yield* Base);
  const harness = yield* OpenCode.Harness({
    models: [Fast],
    // Every tool is listed both ways: each prompt says how it reaches them.
    tools: [
      AI.CodingTools,
      Add,
      Withdraw,
      CountBytes,
      Stall,
      Codes,
      AI.CodeMode(Add, Withdraw, CountBytes, Codes),
    ],
    skills: [Releasing],
  });

  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    /** The session's sandbox as Boat lists it, if it has one. */
    const sandboxOf = Effect.fn(function* (name: string) {
      const [found] = yield* sandboxes.list({
        labels: { key: harness.session(name).sandboxKey },
      });
      return found;
    });

    return {
      /** Prompt with exactly `tools` as direct calls and `programs` from programs; answers with the reply's text. */
      prompt: Effect.fn(function* (
        name: string,
        text: string,
        tools: ReadonlyArray<keyof typeof toolsByName>,
        requestId: string,
        programs: ReadonlyArray<"add" | "withdraw" | "count_bytes" | "codes">,
      ) {
        const reply = yield* harness.session(name).prompt(text, {
          tools: [
            ...tools.map((tool) => toolsByName[tool]),
            ...(programs.length === 0
              ? []
              : [AI.CodeMode(...programs.map((tool) => toolsByName[tool]))]),
          ],
          requestId,
        });
        return reply.text;
      }),
      /** What the harness added to the session's system prompt for code mode, if anything. */
      section: Effect.fn(function* (name: string) {
        const sessionID = yield* harness.session(name).id;
        const entries = yield* harness.use((client) =>
          client.experimental.session.instructions.entry.list({ sessionID }),
        );
        const section = entries.find((entry) => entry.key === "alchemy-codemode")?.value;
        return typeof section === "string" ? section : null;
      }),
      /** Every tool call the session made, as OpenCode names and reports it. */
      toolsUsed: Effect.fn(function* (name: string) {
        const messages = yield* harness.session(name).messages;
        return messages.flatMap((message) =>
          message.type === "assistant"
            ? (message as OpenCode.AssistantMessage).content.flatMap((content) =>
                content.type === "tool"
                  ? [
                      {
                        tool: content.name,
                        status: content.state?.status,
                        output:
                          content.state?.error?.message ??
                          (content.state?.content ?? []).map((item) => item.text ?? "").join(""),
                      },
                    ]
                  : [],
              )
            : [],
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
      /** Give the session a prompt without waiting for its answer. */
      start: Effect.fn(function* (
        name: string,
        text: string,
        tools: ReadonlyArray<keyof typeof toolsByName>,
      ) {
        yield* harness
          .session(name)
          .submit(text, { tools: tools.map((tool) => toolsByName[tool]) });
      }),
      abort: (name: string) => harness.session(name).abort,
      /** How each run of the session ended, oldest first. */
      outcomes: Effect.fn(function* (name: string) {
        const messages = yield* harness.session(name).messages;
        return messages.flatMap((message) =>
          message.type === "idle" ? [String(message.outcome)] : [],
        );
      }),
      /** Every table and index in this object's SQLite. */
      tables: Effect.fn(function* () {
        yield* harness.session("tables").id;
        const storage = (
          state.raw as unknown as {
            storage: { sql: { exec(query: string): { toArray(): Array<{ name: string }> } } };
          }
        ).storage;
        return storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
          )
          .toArray()
          .map((row) => row.name);
      }),
      /** Kill this instance; the next call or the alarm builds a fresh one. */
      crash: () => state.abort("crash"),
      suspend: (name: string) => harness.session(name).suspendSandbox,
      kill: (name: string) => harness.session(name).removeSandbox,
    };
  });
});

const provided = <R>(CodeModeLive: Layer.Layer<AI.CodeModeConvention, never, R>) =>
  session.pipe(Effect.provide(Layer.mergeAll(HarnessLive, CodeModeLive)));

/** Programs written with promises, run on the Durable Object's own thread. */
export default class OpenCodeSession extends Cloudflare.DurableObject<OpenCodeSession>()(
  "OpenCodeSession",
  provided(AI.CodeModeAsync.pipe(Layer.provide(AICloudflare.EvalQuickJS()))),
) {}

/** Programs written as Effects, run in an isolate loaded for them. */
export class OpenCodeEffectSession extends Cloudflare.DurableObject<OpenCodeEffectSession>()(
  "OpenCodeEffectSession",
  provided(AI.CodeModeEffect.pipe(Layer.provide(AICloudflare.EvalWorkerLoader()))),
) {}

/** OpenCode's own code mode: its `execute` tool. */
export class OpenCodeNativeSession extends Cloudflare.DurableObject<OpenCodeNativeSession>()(
  "OpenCodeNativeSession",
  provided(OpenCode.CodeModeNative),
) {}
