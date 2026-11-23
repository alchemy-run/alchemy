import * as AI from "@alchemy.run/ai";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class Fast extends AI.Model<Fast>()("fast") {}
class Add extends AI.Tool<Add>()("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
}) {}
class Docs extends AI.McpServer<Docs>()("docs") {}

// A process requires a harness and the default model, and nothing it does not mention.
class Bare extends (AI.Process<Bare>()("Bare", { description: "Nothing." })`Say hello.`) {}
type _BareNeedsTheHarness = Assert<
  Equals<Effect.Services<typeof Bare>, AI.Harness | AI.DefaultModel>
>;

// Each mention is a requirement: a tool, a tool tag, an MCP server and a model.
class Research extends (AI.Process<Research>()("Research", {
  description: "Answer one question.",
})`Answer the question with ${Add}, ${AI.Read} and ${Docs}, on ${Fast}.`) {}
type _MentionsAreRequirements = Assert<
  Equals<
    Effect.Services<typeof Research>,
    AI.Harness | AI.DefaultModel | Add | AI.Read | Docs | Fast
  >
>;

// A session that acts as nobody is started with nothing, or on a model.
type Client<P> = P extends Effect.Effect<infer A, any, any> ? A : never;
declare const research: Client<typeof Research>;
void research.start("a");
void research.start("a", { model: Fast });
// @ts-expect-error a process has no inputs
void research.start("a", { question: "Where?" });

// Mentioning a process with its prose on the class brings what that prose requires.
class Lead extends (AI.Process<Lead>()("Lead", {
  description: "Hand out work.",
})`Start a ${Research} for each question, or more of ${AI.Self}.`) {}
type _AMentionedProcessBringsItsRequirements = Assert<
  Equals<Effect.Services<typeof Lead>, Effect.Services<typeof Research>>
>;

// A process declared by name is a tag: yielding it requires only the tag.
class Engineer extends AI.Process<Engineer>()("Engineer", {}) {}
type _ATagRequiresItself = Assert<Equals<Effect.Services<typeof Engineer>, Engineer>>;

// Its Layer requires what its prose mentions, and provides the tag.
const EngineerLive = Engineer.toLayer({ description: "Do it." })`Do the task with ${Add}.`;
type _ALayerRequiresItsMentions = Assert<
  Equals<typeof EngineerLive, Layer.Layer<Engineer, never, AI.Harness | AI.DefaultModel | Add>>
>;

// Mentioning a tag requires the tag, and none of what its prose mentions.
class Manager extends (AI.Process<Manager>()("Manager", {
  description: "Delegate.",
})`Start an ${Engineer}.`) {}
type _AMentionedTagIsRequired = Assert<
  Equals<Effect.Services<typeof Manager>, AI.Harness | AI.DefaultModel | Engineer>
>;

// Without a description, a declaration takes no prose of its own.
// @ts-expect-error the prose goes on `toLayer`
void AI.Process<Engineer>()("Engineer", {})`Do it.`;

// The default model is one of yours, whose Layer it requires.
type _TheDefaultModelRequiresItsModel = Assert<
  Equals<ReturnType<typeof AI.DefaultModel<Fast>>, Layer.Layer<AI.DefaultModel, never, Fast>>
>;
