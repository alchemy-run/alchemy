/**
 * `SamplingPolicy` — the CONTROL-PLANE hook that owns how one model
 * sampling is retried and budgeted (kernel-assembly.md §4). The
 * driver asks the policy to run each sampling; the policy decides
 * retry schedules, transient-vs-deterministic failure handling, and
 * how much malformed-tool-call feedback the model gets before the
 * real error propagates.
 *
 * OPTIONAL, like every hook: a composition that provides nothing gets
 * {@link defaultSamplingPolicy} — today's kernel behavior, verbatim.
 * A user kernel overrides it with a Layer:
 *
 * ```ts
 * const Cautious = Layer.succeed(AI.SamplingPolicy, {
 *   step: (facts, sample) =>
 *     sample.pipe(
 *       Effect.timeout("90 seconds"),
 *       Effect.retry({ times: 1 }),
 *     ),
 *   malformedBudget: 1,
 * });
 * ```
 *
 * The policy NEVER sees prompts or tools — it wraps an opaque effect.
 * Content belongs to the stance; this hook is control only.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { isAiError } from "effect/unstable/ai/AiError";

/** The kernel facts a policy may condition on. */
export interface SamplingFacts {
  readonly term: string;
  readonly key: string;
  readonly tick: number;
}

export interface SamplingPolicyService {
  /**
   * Run ONE sampling. The effect's typed failures pass through to the
   * kernel's crash model (spec §11b) — the policy decides only which
   * failures are RE-SAMPLED and on what schedule.
   */
  readonly step: <A, E>(
    facts: SamplingFacts,
    sample: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  /**
   * Consecutive malformed-tool-call feedback rounds (the kernel tells
   * the model what was wrong and re-samples) before the validation
   * error propagates as the round's real failure.
   */
  readonly malformedBudget: number;
}

export class SamplingPolicy extends Context.Service<
  SamplingPolicy,
  SamplingPolicyService
>()("alchemy/AI/SamplingPolicy") {}

/**
 * The shipped default — the behavior both kernels had before the hook
 * existed: retryability is the error's own testimony (a deterministic
 * failure — billing, auth, content policy — must not be re-sampled;
 * unknown errors are presumed transient), exponential backoff from one
 * second, three retries; three malformed-call feedback rounds.
 */
export const defaultSamplingPolicy: SamplingPolicyService = {
  step: (_facts, sample) =>
    sample.pipe(
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
  malformedBudget: 3,
};

export const SamplingPolicyDefault = Layer.succeed(
  SamplingPolicy,
  defaultSamplingPolicy,
);
