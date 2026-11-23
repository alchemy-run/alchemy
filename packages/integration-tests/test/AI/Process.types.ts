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

const question = AI.Input("question", Schema.String);
const depth = AI.Input("depth", Schema.optionalKey(Schema.Number));

// A process requires a harness and the default model, and nothing it does not mention.
class Bare extends (AI.Process<Bare>()("Bare", { description: "Nothing." })`Say hello.`) {}
type _BareNeedsTheHarness = Assert<
  Equals<Effect.Services<typeof Bare>, AI.Harness | AI.DefaultModel>
>;

// Each mention is a requirement: a tool, a tool tag, an MCP server and a model.
class Research extends (AI.Process<Research>()("Research", {
  description: "Answer one question.",
})`Answer ${question} to ${depth} levels with ${Add}, ${AI.Read} and ${Docs}, on ${Fast}.`) {}
type _MentionsAreRequirements = Assert<
  Equals<
    Effect.Services<typeof Research>,
    AI.Harness | AI.DefaultModel | Add | AI.Read | Docs | Fast
  >
>;

// The inputs a process is started with are the ones its prose mentions.
type Client<P> = P extends Effect.Effect<infer A, any, any> ? A : never;
declare const research: Client<typeof Research>;
void research.start("a", { question: "Where?" });
void research.start("a", { question: "Where?", depth: 2 }, { model: Fast });
// @ts-expect-error the input the prose mentions is required
void research.start("a", {});
// @ts-expect-error an input is typed by its schema
void research.start("a", { question: 1 });

// A process without inputs is started with none.
declare const bare: Client<typeof Bare>;
void bare.start("a");

// Mentioning a process with its prose on the class brings what that prose requires.
class Lead extends (AI.Process<Lead>()("Lead", {
  description: "Hand out work.",
})`Start a ${Research} for each question, or more of ${AI.Self}.`) {}
type _AMentionedProcessBringsItsRequirements = Assert<
  Equals<Effect.Services<typeof Lead>, Effect.Services<typeof Research>>
>;

// A process declared by name and inputs is a tag: yielding it requires only the tag.
class Engineer extends AI.Process<Engineer>()("Engineer", { inputs: [question] }) {}
type _ATagRequiresItself = Assert<Equals<Effect.Services<typeof Engineer>, Engineer>>;

// Its Layer requires what its prose mentions, and provides the tag.
const EngineerLive = Engineer.toLayer({ description: "Do it." })`Do ${question} with ${Add}.`;
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

// Prose for a tag may only mention the inputs the tag lists.
// @ts-expect-error `depth` is not an input of Engineer
Engineer.toLayer({ description: "Wrong." })`Do ${question} to ${depth} levels.`;

// The default model is one of yours, whose Layer it requires.
type _TheDefaultModelRequiresItsModel = Assert<
  Equals<ReturnType<typeof AI.DefaultModel<Fast>>, Layer.Layer<AI.DefaultModel, never, Fast>>
>;
