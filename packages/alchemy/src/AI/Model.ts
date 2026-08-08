/**
 * `Model` — the driver service that makes ONE CALL TO THE MODEL:
 * streaming the provider wire, consolidating deltas back into the
 * response shape the round consumes, surfacing live parts as they
 * stream, and the retry/budget policy for transient failures.
 *
 * Shared by every driver assembly (memory, sqlite, Cloudflare). It is
 * a `Context.Service` so a user driver swaps it as a Layer — retry
 * schedules, sampling timeouts, model tiering, malformed budgets all
 * live INSIDE the user's Model, never as separate policy objects:
 *
 * ```ts
 * const OrgModel = Layer.effect(
 *   AI.Model,
 *   Effect.map(LanguageModel.LanguageModel, (model) => ({
 *     ...AI.makeModel(model),
 *     malformedBudget: 1,
 *   })),
 * );
 * ```
 *
 * Absent, the drivers build {@link makeModel} over their own
 * LanguageModel — today's behavior, verbatim.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isAiError } from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Prompt from "effect/unstable/ai/Prompt";
import * as Response from "effect/unstable/ai/Response";
import type * as Toolkit from "effect/unstable/ai/Toolkit";

/** A live wire fact, surfaced AS IT STREAMS (deltas, tool calls). */
export type LivePart =
  | { readonly kind: "text" | "reasoning"; readonly delta: string }
  | {
      readonly kind: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly params: unknown;
    };

export interface ModelService {
  /**
   * One sampling — tool handlers execute INSIDE this call; `onLive`
   * surfaces deltas and tool calls as they stream. Typed failures
   * pass through to the round's crash model (spec §11b); the Model
   * decides only which failures are RE-SAMPLED and on what schedule.
   */
  readonly step: (options: {
    readonly prompt: Prompt.Prompt;
    readonly toolkit: Toolkit.WithHandler<any> | undefined;
    readonly onLive?: (part: LivePart) => Effect.Effect<void>;
  }) => Effect.Effect<LanguageModel.GenerateTextResponse<any>, unknown>;
  /**
   * Consecutive malformed-tool-call feedback rounds (the driver tells
   * the model what was invalid and re-samples) before the validation
   * error propagates as the round's real failure.
   */
  readonly malformedBudget: number;
}

export class Model extends Context.Service<Model, ModelService>()(
  "alchemy/AI/Model",
) {}

/** The model surface the default Model needs. */
interface StreamingModel {
  readonly streamText: unknown;
}

/**
 * The default Model over a LanguageModel — the behavior both
 * drivers shipped before the seam existed:
 *
 * - The wire is STREAMED so an observer sees text/thinking tokens as
 *   they arrive; parts are consolidated back into the non-streaming
 *   response shape the round consumes, block metadata merged across
 *   deltas (Anthropic's thinking SIGNATURE arrives as a late empty
 *   delta and must survive onto the consolidated reasoning part, or
 *   the next request fails).
 * - Tool RESULTS are load-bearing: they are what
 *   `Prompt.fromResponseParts` turns into the tool message answering
 *   the call. Drop one and the thread records a call nothing ever
 *   answered — providers reject that, and a model that reads its own
 *   thread calls the tool again forever.
 * - Retryability is the error's own testimony (spec §11b): a
 *   deterministic failure (billing, auth, content policy) must not be
 *   re-sampled — it propagates TYPED to the round. A MALFORMED TOOL
 *   CALL is excluded from blind re-sampling: the round feeds it back
 *   to the model as a corrective note.
 */
export const makeModel = (model: StreamingModel): ModelService => ({
  malformedBudget: 3,
  step: ({ prompt, toolkit, onLive = () => Effect.void }) =>
    Effect.gen(function* () {
      const parts: Array<unknown> = [];
      // open blocks by stream id (providers interleave by index)
      const open = new Map<
        string,
        { type: "text" | "reasoning"; text: string; metadata: any }
      >();
      yield* Stream.runForEach(
        (model.streamText as (options: unknown) => Stream.Stream<any, unknown>)(
          { prompt, toolkit },
        ),
        (part: any) =>
          Effect.gen(function* () {
            switch (part.type) {
              case "text-start":
              case "reasoning-start": {
                open.set(part.id, {
                  type: part.type === "text-start" ? "text" : "reasoning",
                  text: "",
                  metadata: { ...part.metadata },
                });
                return;
              }
              case "text-delta":
              case "reasoning-delta": {
                const kind = part.type === "text-delta" ? "text" : "reasoning";
                const block = open.get(part.id) ?? {
                  type: kind as "text" | "reasoning",
                  text: "",
                  metadata: {},
                };
                open.set(part.id, block);
                block.text += part.delta;
                Object.assign(block.metadata, part.metadata);
                if (part.delta.length > 0) {
                  yield* onLive({ kind, delta: part.delta });
                }
                return;
              }
              case "text-end":
              case "reasoning-end": {
                const block = open.get(part.id);
                if (block === undefined) return;
                open.delete(part.id);
                Object.assign(block.metadata, part.metadata);
                parts.push(
                  Response.makePart(block.type, {
                    text: block.text,
                    metadata: block.metadata,
                  } as never),
                );
                return;
              }
              case "tool-call": {
                parts.push(part);
                // surface the call NOW — its handler may session for
                // minutes before the sampling completes
                yield* onLive({
                  kind: "tool-call",
                  id: part.id,
                  name: part.name,
                  params: part.params,
                });
                return;
              }
              case "tool-result":
              case "finish": {
                parts.push(part);
                return;
              }
              default:
                return;
            }
          }),
      );
      // a provider that never closed a block still yields its text
      for (const block of open.values()) {
        parts.push(
          Response.makePart(block.type, {
            text: block.text,
            metadata: block.metadata,
          } as never),
        );
      }
      return new LanguageModel.GenerateTextResponse<any>(parts as never);
    }).pipe(
      Effect.retry({
        while: (error) =>
          isAiError(error)
            ? error.isRetryable &&
              error.reason._tag !== "ToolParameterValidationError"
            : true,
        schedule: Schedule.exponential("1 second"),
        times: 3,
      }),
    ),
});

/** The default Model as a Layer, for user drivers that want to wrap
 *  rather than replace it. */
export const ModelDefault: Layer.Layer<
  Model,
  never,
  LanguageModel.LanguageModel
> = Layer.effect(
  Model,
  Effect.map(LanguageModel.LanguageModel, (model) =>
    makeModel(model as StreamingModel),
  ),
);
