import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";

export type Step = (
  options: LanguageModel.ProviderOptions,
  index: number,
) => ReadonlyArray<Response.PartEncoded>;

export const make = (steps: ReadonlyArray<Step>) => {
  const calls: LanguageModel.ProviderOptions[] = [];
  const nextStep = (options: LanguageModel.ProviderOptions) => {
    const index = calls.length;
    calls.push(options);
    return [...steps[Math.min(index, steps.length - 1)]!(options, index)];
  };
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) => Effect.sync(() => nextStep(options)),
      // the driver samples over the STREAMING wire: serve the same
      // script, whole parts re-cut as start/delta/end triples the way
      // a real provider streams them
      streamText: (options) =>
        Stream.fromIterable(nextStep(options).flatMap(streamed)),
    }),
  );
  return { calls, layer };
};

/** Re-cut one whole response part as its streaming part sequence. */
const streamed = (
  part: Response.PartEncoded,
  index: number,
): Array<Response.StreamPartEncoded> => {
  if (part.type === "text" || part.type === "reasoning") {
    const id = `part-${index}`;
    const prefix = part.type === "text" ? "text" : "reasoning";
    return [
      { type: `${prefix}-start`, id },
      { type: `${prefix}-delta`, id, delta: part.text },
      { type: `${prefix}-end`, id },
    ] as Array<Response.StreamPartEncoded>;
  }
  return [part as Response.StreamPartEncoded];
};

export const text = (value: string): Response.PartEncoded =>
  ({ type: "text", text: value }) as Response.PartEncoded;

export const toolCall = (name: string, params: unknown): Response.PartEncoded =>
  ({
    type: "tool-call",
    id: `call-${name}`,
    name,
    params,
  }) as Response.PartEncoded;

export const finish = (
  reason: "stop" | "tool-calls" = "stop",
): Response.PartEncoded =>
  ({
    type: "finish",
    reason,
    response: undefined,
    usage: {
      inputTokens: {
        uncached: undefined,
        total: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: undefined,
        text: undefined,
        reasoning: undefined,
      },
    },
  }) as unknown as Response.PartEncoded;

export const promptText = (options: LanguageModel.ProviderOptions): string =>
  JSON.stringify(options.prompt.content);
