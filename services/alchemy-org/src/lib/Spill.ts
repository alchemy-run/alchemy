/**
 * The SPILL NET — the org's backstop for tool output that nothing
 * else bounded: an {@link AI.ToolEngine} that keeps DIRECT
 * presentation (every mention stays its own provider tool — the
 * compiled `mention.tool` passes straight through) and wraps every
 * handler so an oversized SUCCESS lands in the {@link ToolOutputStore}
 * with only a head preview + readOutput id entering the context.
 *
 * Tools with tailored policies (bash's per-channel tails, readFile's
 * paging, grep's line caps) stay untouched — their results come back
 * under the cap and pass through verbatim. The net exists for the
 * rest: API-reading tools (readDiff), inline charter tools, and every
 * future tool nobody remembered to bound.
 *
 * Best-effort by doctrine (dsh's rule): a spill failure keeps the
 * oversized inline result — it never turns a successful call into an
 * error. Failures pass through untouched; the model needs them exact.
 */
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { truncateHead } from "./Output.ts";
import { ToolOutputStore } from "./ToolOutputStore.ts";

/** Above this, a result is spilled — comfortably above every tailored
 *  tool policy's own cap (50KB), so the net only catches the unbounded. */
const MAX_INLINE_BYTES = 60_000;
const PREVIEW_LINES = 200;

export const SpillTools = Layer.effect(
  AI.ToolEngine,
  Effect.gen(function* () {
    const store = yield* ToolOutputStore;
    const wrap = (mention: AI.ToolMention): AI.ToolMention => ({
      ...mention,
      handler: (input) =>
        mention.handler(input).pipe(
          Effect.flatMap((result) => {
            if (
              typeof result !== "string" ||
              result.length <= MAX_INLINE_BYTES
            ) {
              return Effect.succeed(result);
            }
            return Effect.gen(function* () {
              const artifact = yield* store.create(mention.name);
              yield* artifact.append(result);
              const preview = truncateHead(result, {
                maxLines: PREVIEW_LINES,
                maxBytes: MAX_INLINE_BYTES,
              });
              return (
                `${preview.text}\n[Output truncated: ${preview.shownLines} of ` +
                `${preview.totalLines} lines shown. Full output: ${artifact.id} — ` +
                `page it with readOutput]`
              );
            }).pipe(Effect.catch(() => Effect.succeed(result)));
          }),
        ),
    });
    return {
      present: (mentions) => {
        const wrapped = mentions.map(wrap);
        return Effect.succeed({
          tools: wrapped.map((mention) => mention.tool),
          handlers: Object.fromEntries(
            wrapped.map((mention) => [mention.name, mention.handler]),
          ),
        });
      },
    };
  }),
);
