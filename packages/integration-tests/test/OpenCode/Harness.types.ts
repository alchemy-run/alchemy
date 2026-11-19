import * as AI from "@alchemy.run/ai";
import * as OpenCode from "@alchemy.run/opencode";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Fast extends AI.Model<Fast>()("fast") {}

// The declarations a Pi harness takes, unchanged.
class Add extends AI.Tool<Add>()("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
}) {}
class Docs extends AI.McpServer<Docs>()("docs") {}
class Releasing extends AI.Skill<Releasing>()("releasing", {
  description: "Cut a release.",
  instructions: "Run the tests, then deploy.",
}) {}

// OpenCode runs in a sandbox, so every harness needs one, and an instance to key it on.
const bare = OpenCode.Harness({ models: [Fast] });
type _AlwaysNeedsSandboxes = Assert<
  Equals<Effect.Services<typeof bare>, OpenCode.Instance | AI.Sandboxes | Fast>
>;

// OpenCode's own tools add nothing; a tool and an MCP server require their Layers.
const full = OpenCode.Harness({
  models: [Fast],
  tools: [OpenCode.CodingTools, OpenCode.WebFetch, Add, Docs],
  skills: [Releasing],
});
type _ListedToolsNeedTheirLayers = Assert<
  Equals<Effect.Services<typeof full>, OpenCode.Instance | AI.Sandboxes | Fast | Add | Docs>
>;

// An inline tool closes over what is in scope and requires nothing more.
const Echo = AI.Tool(
  "echo",
  {
    description: "Say it back.",
    parameters: Schema.Struct({ text: Schema.String }),
    success: Schema.String,
  },
  Effect.fn(function* ({ text }) {
    return text;
  }),
);
const inline = OpenCode.Harness({ models: [Fast], tools: [Echo] });
type _InlineToolNeedsNothing = Assert<
  Equals<Effect.Services<typeof inline>, OpenCode.Instance | AI.Sandboxes | Fast>
>;

export type { _AlwaysNeedsSandboxes, _InlineToolNeedsNothing, _ListedToolsNeedTheirLayers };
