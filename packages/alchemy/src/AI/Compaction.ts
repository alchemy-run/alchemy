import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Prompt from "effect/unstable/ai/Prompt";
import * as Result from "effect/Result";
import {
  observational,
  type ObservationalOptions,
} from "./CompactionObservational.ts";
import type { CompactPlan, ThreadService } from "./Thread.ts";

/**
 * A COMPACTION POLICY — userland's standing answer to "should this
 * thread compact now, and into what?". The driver consults the
 * ambient policy at every sampling boundary (exactly where explicit
 * `thread.compact` requests apply); a policy that returns a plan
 * triggers the same ledgered mechanism, stamped with the policy's
 * name as the generation's author.
 *
 * The seam keeps the framework's law intact: the driver owns the
 * MECHANISM (when plans apply, how generations are recorded), the
 * policy Layer owns the JUDGMENT (thresholds, what survives, who
 * writes the summary). Swap physics without touching the charter:
 *
 * ```ts
 * export const EngineerLive = Engineer.make`
 *   ...charter prose...
 * `.pipe(Layer.provide(AI.Compaction.reset({ at: 120_000 })));
 * ```
 *
 * `consider` receives the thread (read-only) and the MODEL of the
 * last sampling when one is known — a policy that authors summaries
 * samples that same model; a policy without one (the session never
 * sampled) must decline.
 */
export interface CompactionPolicy {
  readonly name: string;
  readonly consider: (
    thread: ThreadService,
    model: LanguageModel.LanguageModel | undefined,
  ) => Effect.Effect<CompactPlan | undefined>;
}

export class Compaction extends Context.Service<Compaction, CompactionPolicy>()(
  "alchemy/AI/Compaction",
) {
  /** No standing policy — today's behavior: only explicit
   *  `thread.compact` requests apply. */
  static readonly none: Layer.Layer<Compaction> = Layer.succeed(
    Compaction,
    Compaction.of({ name: "none", consider: () => Effect.succeed(undefined) }),
  );
  /** Reset-with-handoff at a token threshold — see {@link reset}. */
  static readonly reset = (options: ResetOptions): Layer.Layer<Compaction> =>
    reset(options);
  /** Two-tier observer/reflector memory — see {@link observational}. */
  static readonly observational = (
    options?: ObservationalOptions,
  ): Layer.Layer<Compaction> => observational(options);
}

/**
 * The rolling-handoff summary template. Structure over prose: exact
 * file paths, symbols, commands, and error strings survive; the
 * summary never mentions that summarization happened.
 */
export const DEFAULT_HANDOFF = `## Objective
## Important context (paths, symbols, commands, error strings — exact)
## Work state (completed / active / blocked)
## Next move`;

export interface ResetOptions {
  /** Estimated-token threshold (chars/4 heuristic — `thread.tokens`). */
  readonly at: number;
  /** Markdown skeleton the summary must follow. */
  readonly template?: string;
}

/**
 * Reset-with-handoff at a token threshold: when the thread passes
 * `at` estimated tokens, the MODEL authors a summary of the whole
 * transcript against a fixed template, and the thread restarts from
 * it (a `reset` plan — the driver's ledger keeps every shadowed row
 * addressable). The freshest exchanges are carried verbatim inside
 * the summary's tail section rather than as rows: one message, one
 * ledger entry, no split-turn bookkeeping.
 */
const reset = (options: ResetOptions): Layer.Layer<Compaction> =>
  Layer.succeed(
    Compaction,
    Compaction.of({
      name: "reset",
      consider: (thread, model) =>
        Effect.gen(function* () {
          if (model === undefined) return undefined;
          const tokens = yield* thread.tokens;
          if (tokens < options.at) return undefined;
          const entries = yield* thread.entries;
          const transcript = renderTranscript(entries);
          // a summarizer failure declines the compaction — the thread
          // keeps working and the next boundary tries again
          const sampled = yield* Effect.result(
            model.generateText({
              prompt:
                `<conversation>\n${transcript}\n</conversation>\n\n` +
                `Summarize the conversation above so work can continue ` +
                `from the summary alone. Output EXACTLY this Markdown ` +
                `structure:\n\n${options.template ?? DEFAULT_HANDOFF}\n\n` +
                `Preserve exact file paths, symbols, commands, and error ` +
                `strings. Do not mention the summary process.`,
            }),
          );
          if (Result.isFailure(sampled)) return undefined;
          const summary = sampled.success.text.trim();
          if (summary.length === 0) return undefined;
          return { reset: { summary } };
        }),
    }),
  );

/**
 * Render a thread's messages as a plain transcript for a summarizer —
 * tool payloads truncated so one giant result can't dominate.
 */
export const renderTranscript = (
  entries: ReadonlyArray<Prompt.Message>,
): string =>
  entries
    .map((entry) => {
      // user message content may be a bare string
      const parts =
        typeof entry.content === "string"
          ? entry.content
          : renderParts(entry.content);
      return parts.length === 0 ? "" : `[${entry.role}]\n${parts}`;
    })
    .filter((block) => block.length > 0)
    .join("\n\n");

const renderParts = (
  content: ReadonlyArray<
    | Prompt.UserMessagePart
    | Prompt.AssistantMessagePart
    | Prompt.ToolMessagePart
  >,
): string =>
  content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "tool-call") {
        return `[tool call] ${part.name}(${clip(JSON.stringify(part.params), 400)})`;
      }
      if (part.type === "tool-result") {
        return `[tool result] ${clip(JSON.stringify(part.result), 2000)}`;
      }
      if (part.type === "reasoning") return "";
      return `[${part.type}]`;
    })
    .filter((text) => text.length > 0)
    .join("\n");

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;
