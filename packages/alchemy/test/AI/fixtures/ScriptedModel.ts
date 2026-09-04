/**
 * A SCRIPTED LanguageModel for driver tests — no network, no mocking
 * framework: `LanguageModel.make` accepts a plain function, so the
 * "model" is a list of steps, one per call, each returning the encoded
 * response parts the provider would have produced. Every call's
 * `ProviderOptions` (prompt, tools) is recorded for assertions.
 *
 * Calls beyond the script's length replay the LAST step — a scripted
 * model never hangs the loop.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";

export type Step = (
  options: LanguageModel.ProviderOptions,
  callIndex: number,
) => ReadonlyArray<Response.PartEncoded>;

export interface ScriptedModel {
  readonly layer: Layer.Layer<LanguageModel.LanguageModel>;
  /** Every model call's options, in order — appended live. */
  readonly calls: Array<LanguageModel.ProviderOptions>;
}

export const make = (script: ReadonlyArray<Step>): ScriptedModel => {
  const calls: Array<LanguageModel.ProviderOptions> = [];
  const nextStep = (options: LanguageModel.ProviderOptions) => {
    const index = calls.length;
    calls.push(options);
    const step = script[Math.min(index, script.length - 1)];
    return step === undefined ? [] : [...step(options, index)];
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
  return { layer, calls };
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

// ─── canned parts ───────────────────────────────────────────────────

export const text = (content: string): Response.PartEncoded =>
  ({ type: "text", text: content }) as Response.PartEncoded;

export const toolCall = (
  name: string,
  params: unknown,
  id?: string,
): Response.PartEncoded =>
  ({
    type: "tool-call",
    id: id ?? `call-${name}`,
    name,
    params,
  }) as Response.PartEncoded;

export const finish = (
  reason: "stop" | "tool-calls" = "stop",
): Response.PartEncoded =>
  ({
    type: "finish",
    reason,
    // every key must be PRESENT (UndefinedOr, not optional)
    response: undefined,
    usage: {
      inputTokens: {
        uncached: undefined,
        total: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
  }) as unknown as Response.PartEncoded;

/** The full conversation a call saw, flattened for `toContain` checks. */
export const promptText = (options: LanguageModel.ProviderOptions): string =>
  JSON.stringify(options.prompt.content);
