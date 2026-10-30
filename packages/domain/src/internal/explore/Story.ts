import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
/**
 * Story conversion. The steps a trace would emit are run on the REAL
 * Story runner (`bindings.run`). A Story is returned only when that run fails
 * on the rule's own assertion (`ruleFails(id)` from the rule's tail); any
 * other outcome is `UnsupportedStoryTrace(reason)`. No second model of the
 * Story schedule lives here.
 */
import { Story } from "../../Story.ts";
import { enabled, freshWorld, runOnce, type Built, type Rule } from "./Engine.ts";
import { EngineFault, UnsupportedStoryTrace } from "./Errors.ts";
import type { Send } from "./Host.ts";
import { checkTrace, type Trace } from "./Trace.ts";

export interface StoryBindings {
  /** The TS of an aggregate instance ref. */
  readonly ref: (agg: string, id: string) => string;
  /** The aggregate class, to build the real step. */
  readonly aggregate: (agg: string) => { readonly ref: (id: string) => unknown };
  /** Imports, the `run` helper; `run(...steps)` returns a Promise. */
  readonly header: (body: string) => string;
  /** A statement that refuses to run on another model (see `assertModelHash`). */
  readonly modelGuard?: (modelHash: string) => string;
  /** The real Story runner over the model's real layer. */
  readonly run: (steps: ReadonlyArray<unknown>) => Effect.Effect<void, unknown>;
}

export const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** The text a Story tail throws when the rule breaks. */
export const ruleFails = (id: string) => `EXPLORE-RULE ${id}`;

/** Print a value as a TS expression; a plain object keeps its `_tag`. */
export const toCode = (v: unknown): string => {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (DateTime.isDateTime(v))
    return `DateTime.makeUnsafe(${JSON.stringify(DateTime.formatIso(v as DateTime.Utc))})`;
  if (v instanceof Date) return `new Date(${JSON.stringify(v.toISOString())})`;
  if (Array.isArray(v)) return `[${v.map(toCode).join(", ")}]`;
  const tag = (v as { _tag?: unknown })._tag;
  const ctor = (v as object).constructor?.name;
  const isClass = typeof tag === "string" && ctor !== undefined && ctor !== "Object";
  const entries = Object.entries(v as object).filter(
    ([k, x]) => (isClass ? k !== "_tag" : true) && x !== undefined,
  );
  const body = `{ ${entries.map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${toCode(x)}`).join(", ")} }`;
  return isClass ? `new ${tag}(${body})` : body;
};

export interface StoryOut {
  readonly code: string;
  readonly sends: number;
}

const failureText = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause) as { message?: string; reason?: string };
  return `${e?.message ?? ""} ${e?.reason ?? ""} ${String(e)}`;
};

/** A Story of a trace, proven RED on the rule on the real runner, or a refusal. `b` is a fresh build. */
export const toStory = async (
  b: Built,
  trace: Trace,
  rule: Rule,
  message: string,
  bindings: StoryBindings,
): Promise<StoryOut | UnsupportedStoryTrace> => {
  if (!rule.storyTail)
    return new UnsupportedStoryTrace({ reason: `rule ${rule.id} has no Story tail` });
  // The trace first: every digest and the rule failure on this build.
  const replayed = checkTrace(b, trace);
  const steps: Array<unknown> = [Story.clock(iso(b.scenario.startTimeMillis))];
  const lines: Array<string> = [
    `    Story.clock(${JSON.stringify(iso(b.scenario.startTimeMillis))}),`,
  ];
  const provided = new Map<string, string>();
  let sends = 0;
  let world = freshWorld(b.scenario);
  for (const [i, s] of trace.steps.entries()) {
    const move = enabled(b, world).find((m) => m.key === s.move);
    if (!move) throw new EngineFault("ReplayDiverged", `step ${i + 1}: ${s.move} is not enabled`);
    if (move.kind === "redeliver")
      return new UnsupportedStoryTrace({
        reason: `step ${i + 1}: a redelivery (the Story host delivers once)`,
      });
    if ((move.kind === "run" || move.kind === "timer") && s.choices.some((c) => c.chosen !== 0))
      return new UnsupportedStoryTrace({
        reason: `step ${i + 1}: ${s.label} took a fault or a fake's other answer (a Story cannot)`,
      });
    if ((move.kind === "timer" || move.kind === "tick") && move.at! > world.clock) {
      steps.push(Story.clock(iso(move.at!)));
      lines.push(`    Story.clock(${JSON.stringify(iso(move.at!))}),`);
    }
    const leaf = runOnce(b, world, move, s.choices);
    if (move.kind === "actor") {
      lines.push(`    // ${move.label}`);
      for (const send of leaf.log.sends as ReadonlyArray<Send>) {
        if (send.fault?.includes("lost before commit")) {
          lines.push(`    // host fault: ${send.fault}: not sent`);
          continue;
        }
        for (const p of send.provide)
          if (provided.get(p.keyCode) !== p.code) {
            steps.push((Story.provide as any)(p.key, p.value));
            lines.push(`    Story.provide(${p.keyCode}, ${p.code}),`);
            provided.set(p.keyCode, p.code);
          }
        steps.push(
          (Story.when as any)(bindings.aggregate(send.agg).ref(send.id), send.command, {
            commandId: send.commandId,
          }),
        );
        lines.push(
          `    Story.when(${bindings.ref(send.agg, send.id)}, ${toCode(send.command)}, { commandId: ${JSON.stringify(send.commandId)} }),`,
        );
        sends++;
        if (send.rejection !== undefined && !send.fault) {
          steps.push((Story.rejected as any)(send.rejection));
          lines.push(`    Story.rejected(${toCode(send.rejection)}),`);
        }
        if (send.fault) lines.push(`    // host fault: ${send.fault}: the writer stops here`);
      }
    }
    world = leaf.world;
  }
  const tail = rule.storyTail({ message, world: replayed.world });
  // The proof: the real runner must fail on the rule's own assertion.
  const exit = await Effect.runPromiseExit(bindings.run([...steps, ...tail.steps]));
  if (Exit.isSuccess(exit))
    return new UnsupportedStoryTrace({
      reason: `the real Story passes: its schedule does not reach the break of ${rule.id}`,
    });
  const text = failureText(exit.cause);
  if (!text.includes(ruleFails(rule.id)))
    return new UnsupportedStoryTrace({
      reason: `the real Story fails before the rule: ${text.slice(0, 200)}`,
    });
  const body = `/**
 * Generated by Explore for rule ${rule.id}: ${rule.text ?? ""}
 * Source: ${rule.source ?? ""}
 * Broken: ${message}
 * Trace: ${trace.steps.length} moves. Proven on the real Story runner: it fails on this rule.
 * Model hash: ${trace.modelHash}. Fingerprint: ${trace.fingerprint}.
 */
${bindings.modelGuard?.(trace.modelHash) ?? ""}
test(${JSON.stringify(`explore ${rule.id}`)}, () =>
  run(
${lines.join("\n")}
${tail.code.join("\n")}
  ))
`;
  return { code: bindings.header(body) + body, sends };
};
