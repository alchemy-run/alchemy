import * as AI from "@alchemy.run/ai";
import * as Pi from "@alchemy.run/pi";
import type * as Effect from "effect/Effect";
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

// The coding tools, as a group or one at a time, require a sandbox.
const coding = Pi.Harness({ models: [Fast], tools: [Pi.CodingTools, Add] });
type _CodingToolsNeedSandbox = Assert<
  Equals<Effect.Services<typeof coding>, Pi.Storage | Fast | Add | AI.Sandbox>
>;
const bash = Pi.Harness({ models: [Fast], tools: [Pi.Bash] });
type _OneCodingToolNeedsSandbox = Assert<
  Equals<Effect.Services<typeof bash>, Pi.Storage | Fast | AI.Sandbox>
>;

// An MCP server listed as a tool requires its client Layer.
class Docs extends AI.McpServer<Docs>()("docs") {}
const withServer = Pi.Harness({ models: [Fast], tools: [Add, Docs] });
type _McpServerNeedsItsLayer = Assert<
  Equals<Effect.Services<typeof withServer>, Pi.Storage | Fast | Add | Docs>
>;

// A tool of Pi's own may use `Pi.Env`, so it requires a sandbox too.
class Count extends Pi.Tool<Count>()("count", {
  description: "Count the bytes of a file.",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.Number,
}) {}
const own = Pi.Harness({ models: [Fast], tools: [Count] });
type _PiToolNeedsSandbox = Assert<
  Equals<Effect.Services<typeof own>, Pi.Storage | Fast | Count | AI.Sandbox>
>;
