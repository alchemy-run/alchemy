import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Prompt from "effect/unstable/ai/Prompt";
import * as Result from "effect/Result";
import { Compaction, renderTranscript } from "./Compaction.ts";
import type { CompactPlan } from "./Thread.ts";

/**
 * The OBSERVATIONAL compaction policy — two-tier memory (observation-
 * log design after mastra's observational memory): a cheap OBSERVER
 * watches the thread and distills unobserved history into a dated,
 * priority-tagged observation log that heads each new generation;
 * when the log itself grows past its budget, a REFLECTOR rewrites the
 * WHOLE log more densely. Every advance is a ledgered generation
 * (`kind: "observe" | "reflect"`), so the raw rows a log shadows stay
 * addressable (`messagesAt`, the `Recall` tool).
 *
 * Learnings the observer marks as durable (its `## Journal` section)
 * are handed to the `journal` hook and kept OUT of the log — task
 * state stays at the desk, learnings climb (Identity wires the hook
 * to the self-thread).
 */
export interface ObservationalOptions {
  /**
   * Estimated-token threshold (chars/4 heuristic) of UNOBSERVED
   * thread — everything after the log note — before the observer runs.
   * @default 30_000
   */
  readonly observeAt?: number;
  /**
   * Estimated-token threshold of the observation log itself before
   * the reflector rewrites it. Reflection wins over observation when
   * both trigger.
   * @default 40_000
   */
  readonly reflectAt?: number;
  /**
   * Fraction of the unobserved span kept verbatim behind the log
   * note (at least one message survives).
   * @default 0.2
   */
  readonly keepTail?: number;
  /**
   * The cheap watcher that authors observations and reflections.
   * Defaults to the model handed to `consider` — the one the session
   * samples with.
   */
  readonly observer?: LanguageModel.LanguageModel;
  /**
   * Receives the entries the observer marked as durable learnings
   * (the `## Journal` bullets, stripped of their markers). They never
   * appear in the log doc. Default: no-op.
   */
  readonly journal?: (entries: ReadonlyArray<string>) => Effect.Effect<void>;
}

/**
 * Build the observational policy Layer — attach it on the charter
 * like any other policy: `AI.Compaction.observational({ observer })`.
 * Any model failure declines the compaction (the thread keeps working
 * and the next boundary tries again); the loop is never crashed.
 */
export const observational = (
  options?: ObservationalOptions,
): Layer.Layer<Compaction> =>
  Layer.succeed(
    Compaction,
    Compaction.of({
      name: "observational",
      consider: (thread, model) =>
        Effect.gen(function* () {
          const observer = options?.observer ?? model;
          if (observer === undefined) return undefined;
          const observeAt = options?.observeAt ?? 30_000;
          const reflectAt = options?.reflectAt ?? 40_000;
          const lineage = yield* thread.lineage;
          const tip = lineage[0];
          // the current log: the doc of the most recent observational
          // generation in the chain
          const latest = lineage.find(
            (record) => record.kind === "observe" || record.kind === "reflect",
          );
          const log = latest?.doc ?? "";
          const entries = yield* thread.entries;
          // the head note of an observational generation IS the log —
          // the cursor: everything after it is unobserved history
          const hasLogHead =
            tip !== undefined &&
            (tip.kind === "observe" || tip.kind === "reflect");
          const span = hasLogHead ? entries.slice(1) : entries;

          // reflection wins: a log past its own budget is rewritten
          // before more observations pile onto it
          if (log.length > 0 && estimate(log) >= reflectAt) {
            const reflected = yield* reflect(observer, log);
            if (reflected === undefined) return undefined;
            // only the log note is replaced — every other row of the
            // surface survives verbatim
            const plan: CompactPlan = {
              observe: {
                log: reflected,
                keepTail: span.length,
                kind: "reflect",
              },
            };
            return plan;
          }

          if (estimateSpan(span) < observeAt) return undefined;
          const today = yield* Effect.sync(() =>
            new Date().toISOString().slice(0, 10),
          );
          // an observer failure declines the compaction — the thread
          // keeps working and the next boundary tries again
          const sampled = yield* Effect.result(
            observer.generateText({
              prompt: observerPrompt(log, renderTranscript(span), today),
            }),
          );
          if (Result.isFailure(sampled)) return undefined;
          const parsed = splitJournal(sampled.success.text);
          if (parsed.log.length === 0) return undefined;
          if (parsed.journal.length > 0) {
            yield* options?.journal?.(parsed.journal) ?? Effect.void;
          }
          const keepTail = Math.max(
            1,
            Math.floor(span.length * (options?.keepTail ?? 0.2)),
          );
          const plan: CompactPlan = {
            observe: { log: parsed.log, keepTail, kind: "observe" },
          };
          return plan;
        }),
    }),
  );

/** Chars/4 estimate of a string — the same heuristic as `thread.tokens`. */
const estimate = (text: string): number => Math.ceil(text.length / 4);

/** Chars/4 estimate of a message span. */
const estimateSpan = (span: ReadonlyArray<Prompt.Message>): number =>
  Math.ceil(JSON.stringify(span).length / 4);

/**
 * Split the observer's output into the log body and the `## Journal`
 * section's bullets — journal lines are forwarded to the hook and
 * never stay in the log.
 */
const splitJournal = (
  output: string,
): { readonly log: string; readonly journal: ReadonlyArray<string> } => {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => /^##\s+Journal\b/i.test(line.trim()));
  if (start < 0) return { log: output.trim(), journal: [] };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index]!.trim())) {
      end = index;
      break;
    }
  }
  const journal = lines
    .slice(start + 1, end)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0);
  const log = [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
  return { log, journal };
};

// the "ONLY memory" framing, dated groups, and 🔴🟡🟢✅ priorities are
// adapted from mastra's observational-memory observer/reflector prompts
const observerPrompt = (
  log: string,
  transcript: string,
  today: string,
): string =>
  `You are the memory of an agent. The observation log you maintain ` +
  `is the ONLY record of this thread that survives compaction — ` +
  `anything you leave out is forgotten.\n\n` +
  (log.length > 0 ? `<observation-log>\n${log}\n</observation-log>\n\n` : "") +
  `<conversation>\n${transcript}\n</conversation>\n\n` +
  `Rewrite the ENTIRE observation log: carry every existing entry ` +
  `forward (merged where redundant, dates unchanged) and add entries ` +
  `for the conversation above. Format:\n` +
  `- group entries under \`### <date>\` headings (today is ${today})\n` +
  `- one entry per line: \`- <priority> <observation>\`\n` +
  `- priorities: 🔴 critical facts, goals, and constraints · 🟡 ` +
  `useful detail (tool results, project facts) · 🟢 minor or ` +
  `uncertain · ✅ completed (state exactly WHAT is done, so it is ` +
  `never re-worked)\n` +
  `- terse and dense; preserve exact file paths, symbols, commands, ` +
  `identifiers, and error strings; group repeated similar tool calls ` +
  `under one parent entry\n\n` +
  `If the conversation surfaced DURABLE LEARNINGS — things true ` +
  `beyond this task (codebase patterns, gotchas, conventions), never ` +
  `task state — end with a \`## Journal\` section listing each as ` +
  `one \`- \` bullet. Journal lines are forwarded to durable memory ` +
  `and must NOT appear in the log body. Omit the section when ` +
  `nothing qualifies.\n\n` +
  `Output ONLY the log (and the optional Journal section).`;

const reflectorPrompt = (log: string): string =>
  `You are the same psyche that wrote this observation log, now ` +
  `reflecting on it. The rewritten log you produce becomes the ` +
  `ENTIRE memory — anything you drop is forgotten.\n\n` +
  `<observation-log>\n${log}\n</observation-log>\n\n` +
  `Rewrite the WHOLE log more densely, in the same format (dated ` +
  `\`###\` groups, \`- <priority>\` entries): merge related entries, ` +
  `collapse tool sequences into their outcomes, condense the oldest ` +
  `groups most aggressively while keeping recent detail, and note ` +
  `whether the work drifted off its goal. Preserve every 🔴 fact, ` +
  `every ✅ completion with its concrete outcome, and all dates. The ` +
  `result MUST be substantially shorter than the input. Output ONLY ` +
  `the rewritten log.`;

const REFLECT_PRESSURE =
  `\n\nYour previous rewrite was not smaller than the input. Compress ` +
  `much harder: collapse every tool sequence into its outcome alone, ` +
  `merge same-topic entries into one line each, and drop 🟢 minutiae.`;

/**
 * Run the reflector with a retry-once-if-not-smaller guard: one
 * attempt, and one harder-pressure retry when the rewrite failed to
 * shrink. Still-not-smaller declines (the next boundary tries again)
 * — a "reflection" that grows the log would lose detail for nothing.
 */
const reflect = (
  model: LanguageModel.LanguageModel,
  log: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const first = yield* Effect.result(
      model.generateText({ prompt: reflectorPrompt(log) }),
    );
    if (Result.isFailure(first)) return undefined;
    const attempt = first.success.text.trim();
    if (attempt.length > 0 && attempt.length < log.length) return attempt;
    const second = yield* Effect.result(
      model.generateText({
        prompt: `${reflectorPrompt(log)}${REFLECT_PRESSURE}`,
      }),
    );
    if (Result.isFailure(second)) return undefined;
    const retried = second.success.text.trim();
    return retried.length > 0 && retried.length < log.length
      ? retried
      : undefined;
  });
