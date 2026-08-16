import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ReadOutput } from "../tools/ReadOutput.ts";
import { truncateHead } from "./Output.ts";
import { Artifacts } from "./Artifacts.ts";

/** Above this, a result is spilled — comfortably above every tailored
 *  tool policy's own cap (50KB), so the net only catches the unbounded. */
const MAX_INLINE_BYTES = 60_000;
const PREVIEW_LINES = 200;

/**
 * The net's SELF-PROVIDED redemption: the {@link ReadOutput} alchemy
 * Tool, compiled to the wire (the CodeMode precedent — a `Tools`
 * layer owns its wire shape) so a ticket is redeemable in EVERY
 * charter the net covers, without the author mentioning a retrieval
 * tool: the thing that mints tickets provides the door. A charter
 * that DOES mention its own `readOutput` wins — the mention passes
 * through and the net does not double it.
 */
const readOutputTool = AI.compileTool(ReadOutput as never);

/**
 * The SPILL NET — the org's backstop for tool output that nothing
 * else bounded: an {@link AI.Tools} that keeps DIRECT
 * presentation (every mention stays its own provider tool — the
 * compiled `mention.tool` passes straight through) and wraps every
 * handler so an oversized SUCCESS lands in the {@link Artifacts}
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
 *
 * The net provides its own redemption: a `readOutput` wire tool rides
 * every presentation, so a spill ticket is redeemable in every charter
 * the net covers without the author mentioning a retrieval tool.
 */
export const SpillingTools = Layer.effect(
  AI.Tools,
  Effect.gen(function* () {
    const artifacts = yield* Artifacts;
    // the redemption's IMPLEMENTATION is a requirement of this layer:
    // whoever composes the net must also provide `ReadOutputLive`
    const readOutput = yield* ReadOutput;
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
              const artifact = yield* artifacts.create(mention.name);
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
        const tools = wrapped.map((mention) => mention.tool);
        const handlers = Object.fromEntries(
          wrapped.map((mention) => [mention.name, mention.handler]),
        );
        // the redemption door rides every presentation (stable wire
        // shape), unless the charter mentioned its own readOutput
        if (handlers.readOutput === undefined) {
          tools.push(readOutputTool);
          handlers.readOutput = readOutput as never;
        }
        return Effect.succeed({ tools, handlers });
      },
    };
  }),
);
