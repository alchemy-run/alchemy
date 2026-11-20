import * as AI from "@alchemy.run/ai";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Fast } from "./fixtures/models.ts";

type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Add extends AI.Tool<Add>()("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
}) {}

// A harness with only its own tools needs no sandbox.
const plain = Pi.Harness({ models: [Fast], tools: [Add] });
type _PlainNeedsNoSandbox = Assert<Equals<Effect.Services<typeof plain>, Pi.Storage | Fast | Add>>;

// The coding tools, as a group or one at a time, require a Layer each.
const coding = Pi.Harness({ models: [Fast], tools: [AI.CodingTools, Add] });
type _CodingToolsNeedTheirLayers = Assert<
  Equals<
    Effect.Services<typeof coding>,
    Pi.Storage | Fast | Add | AI.Bash | AI.Read | AI.Edit | AI.Write | AI.Grep | AI.Glob
  >
>;
const bash = Pi.Harness({ models: [Fast], tools: [AI.Bash] });
type _OneCodingToolNeedsItsLayer = Assert<
  Equals<Effect.Services<typeof bash>, Pi.Storage | Fast | AI.Bash>
>;
// Pi's Layers for them work in a sandbox, so they require `AI.Sandboxes`.
type _PiProvidesThem = Assert<
  Equals<
    Layer.Success<typeof Pi.CodingTools>,
    AI.Bash | AI.Read | AI.Edit | AI.Write | AI.Grep | AI.Glob
  >
>;
type _PiToolsNeedSandboxes = Assert<Equals<Layer.Services<typeof Pi.CodingTools>, AI.Sandboxes>>;
// A tool tag implemented by hand takes its schema from the Layer.
const OwnBash = AI.Bash.make(
  {
    description: "Run a command.",
    parameters: Schema.Struct({ command: Schema.String }),
    success: Schema.Number,
  },
  Effect.succeed(
    Effect.fn(function* ({ command }) {
      type _ParametersAreTyped = Assert<Equals<typeof command, string>>;
      const sandbox = yield* AI.Sandbox;
      return (yield* sandbox.exec(command).pipe(Effect.orDie)).exitCode;
    }),
  ),
);
type _OwnToolLayer = Assert<Equals<Layer.Success<typeof OwnBash>, AI.Bash>>;
type _OwnSandboxToolNeedsSandboxes = Assert<Equals<Layer.Services<typeof OwnBash>, AI.Sandboxes>>;

// An MCP server listed as a tool requires its client Layer.
class Docs extends AI.McpServer<Docs>()("docs") {}
const withServer = Pi.Harness({ models: [Fast], tools: [Add, Docs] });
type _McpServerNeedsItsLayer = Assert<
  Equals<Effect.Services<typeof withServer>, Pi.Storage | Fast | Add | Docs>
>;

// A handler that uses the conversation's sandbox (`AI.Sandbox`) requires
// `AI.Sandboxes`: on its Layer when it has one, on the harness otherwise.
class Count extends AI.Tool<Count>()("count", {
  description: "Count the bytes of a file.",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.Number,
}) {}
const CountLive = Count.make(
  Effect.gen(function* () {
    return Effect.fn(function* ({ path }) {
      type _ParametersAreTyped = Assert<Equals<typeof path, string>>;
      const sandbox = yield* AI.Sandbox;
      return (yield* sandbox.readFile(path).pipe(Effect.orDie)).length;
    });
  }),
);
type _SandboxToolLayerNeedsSandboxes = Assert<
  Equals<Layer.Services<typeof CountLive>, AI.Sandboxes>
>;
const AddLive = Add.make(
  Effect.succeed(
    Effect.fn(function* ({ a, b }) {
      return a + b;
    }),
  ),
);
type _PlainToolLayerNeedsNothing = Assert<Equals<Layer.Services<typeof AddLive>, never>>;

class CountInline extends AI.Tool<CountInline>()(
  "count_inline",
  {
    description: "Count the bytes of a file.",
    parameters: Schema.Struct({ path: Schema.String }),
    success: Schema.Number,
  },
  Effect.gen(function* () {
    return Effect.fn(function* ({ path }) {
      type _ParametersAreTyped = Assert<Equals<typeof path, string>>;
      const sandbox = yield* AI.Sandbox;
      return (yield* sandbox.readFile(path).pipe(Effect.orDie)).length;
    });
  }),
) {}
const classInline = Pi.Harness({ models: [Fast], tools: [CountInline] });
type _InlineImplNeedsSandboxes = Assert<
  Equals<Effect.Services<typeof classInline>, Pi.Storage | Fast | AI.Sandboxes>
>;

const CountValue = AI.Tool(
  "count_value",
  {
    description: "Count the bytes of a file.",
    parameters: Schema.Struct({ path: Schema.String }),
    success: Schema.Number,
  },
  Effect.fn(function* ({ path }) {
    type _ParametersAreTyped = Assert<Equals<typeof path, string>>;
    const sandbox = yield* AI.Sandbox;
    return (yield* sandbox.readFile(path).pipe(Effect.orDie)).length;
  }),
);
const value = Pi.Harness({ models: [Fast], tools: [CountValue] });
type _InlineToolNeedsSandboxes = Assert<
  Equals<Effect.Services<typeof value>, Pi.Storage | Fast | AI.Sandboxes>
>;
