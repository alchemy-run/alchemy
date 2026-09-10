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
  /** The same model as a bare SERVICE — what a charter provides to a
   *  stance (`AI.Model`/`Effect.provide`) to sample with this script
   *  instead of the driver's Layer. */
  readonly service: Effect.Effect<LanguageModel.Service>;
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
  const service = LanguageModel.make({
    generateText: (options) => Effect.sync(() => nextStep(options)),
    // the driver samples over the STREAMING wire: serve the same
    // script, whole parts re-cut as start/delta/end triples the way
    // a real provider streams them
    streamText: (options) =>
      Stream.fromIterable(nextStep(options).flatMap(streamed)),
  });
  const layer = Layer.effect(LanguageModel.LanguageModel, service);
  return { layer, service, calls };
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

/** The provider's `response-metadata` part — how the wire names the
 *  model that answered (both Anthropic and OpenAI stream one). */
export const metadata = (modelId: string): Response.PartEncoded =>
  ({ type: "response-metadata", modelId }) as Response.PartEncoded;

export const finish = (
  reason: "stop" | "tool-calls" = "stop",
  usage?: {
    readonly input?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly output?: number;
    readonly reasoning?: number;
  },
): Response.PartEncoded =>
  ({
    type: "finish",
    reason,
    // every key must be PRESENT (UndefinedOr, not optional)
    response: undefined,
    usage: {
      inputTokens: {
        uncached: usage?.input,
        total:
          usage === undefined
            ? undefined
            : (usage.input ?? 0) +
              (usage.cacheRead ?? 0) +
              (usage.cacheWrite ?? 0),
        cacheRead: usage?.cacheRead,
        cacheWrite: usage?.cacheWrite,
      },
      outputTokens: {
        total: usage?.output,
        text: undefined,
        reasoning: usage?.reasoning,
      },
    },
  }) as unknown as Response.PartEncoded;

/** The full conversation a call saw, flattened for `toContain` checks. */
export const promptText = (options: LanguageModel.ProviderOptions): string =>
  JSON.stringify(options.prompt.content);
