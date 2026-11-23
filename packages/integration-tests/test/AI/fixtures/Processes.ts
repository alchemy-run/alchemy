import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const Gateway = Cloudflare.AI.Gateway("ProcessGateway", { collectLogs: true });

/** Llama 3.3 70B reliably returns OpenAI-shaped tool calls on Workers AI. */
export class Fast extends AI.Model<Fast>()("fast") {}

export const ModelsLive = AICloudflare.Model(Fast, {
  gateway: Gateway,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  parameters: { temperature: 0, maxTokens: 1024 },
});

export class Add extends AI.Tool<Add>()("add", {
  description: "Add two integers. Always use this tool to add numbers; never add them yourself.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Struct({ sum: Schema.Number }),
}) {}

/** Off by a thousand, so an answer can only come from the tool. */
export const AddLive = Add.make(({ a, b }) => ({ sum: a + b + 1000 }));

export const a = AI.Input("a", Schema.Number);
export const b = AI.Input("b", Schema.Number);

/** A process with inputs: a session works on them as soon as it starts. */
export class Adder extends AI.Process<Adder>()("Adder", { inputs: [a, b] }) {}

export const AdderLive = Adder.toLayer({
  description: "Add two numbers.",
})`
  Add ${a} and ${b} with ${Add}. Reply with only the sum the tool returned.
`;

/** Prose with a word the model cannot guess, so saying it proves the prose was read. */
export class Releasing extends (AI.Process<Releasing>()("Releasing", {
  description: "How to cut a release, and the release codeword.",
})`
  The release codeword is PLUM-4417. Say it to whoever asks for it.
`) {}

/** A process without inputs that follows one process and starts another. */
export class Operator extends AI.Process<Operator>()("Operator", { inputs: [] }) {}

export const OperatorLive = Operator.toLayer({
  description: "Answer the operator's questions.",
})`
  You are terse.

  When asked for the release codeword, follow ${Releasing} first, then answer.
  When asked to add two numbers, start an ${Adder} with them, in a session
  named as the user says, and reply with only the word started.
`;

/** Every process and what it mentions, on whichever harness is provided. */
export const ProcessesLive = OperatorLive.pipe(
  Layer.provideMerge(AdderLive),
  Layer.provide(Layer.mergeAll(AddLive, AI.DefaultModel(Fast))),
  Layer.provide(ModelsLive),
);
