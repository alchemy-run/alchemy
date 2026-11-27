import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { Asked, Story } from "./ModelSearch.ts";
import { whole } from "./ModelSearch.ts";

/** One step of a `Story`, as data: what the text and the real steps are both made from. */
export type Op =
  | {
      readonly _tag: "Provide";
      readonly name: string;
      readonly tag: unknown;
      readonly value: unknown;
    }
  | { readonly _tag: "Clock"; readonly at: DateTime.Utc }
  | {
      readonly _tag: "When";
      readonly aggregate: string;
      readonly id: string;
      readonly command: unknown;
    }
  | { readonly _tag: "Rejected"; readonly rejection: unknown }
  | { readonly _tag: "Call"; readonly asked: Asked }
  | { readonly _tag: "Answer"; readonly asked: Asked }
  | {
      readonly _tag: "Then";
      readonly aggregate: string;
      readonly id: string;
      readonly events: ReadonlyArray<unknown>;
    }
  | { readonly _tag: "Note"; readonly text: string };

/**
 * A story the explorer found, as the steps of a `Story`. A story stops where
 * what it shows happened; a `Story` has to account for everything the model
 * does, so the steps go on to the end of the sequence the story is the start
 * of.
 */
export const ops = (shown: Story): ReadonlyArray<Op> => {
  const story = whole(shown);
  const made: Array<Op> = [];
  const timed = new Set(story.map((step) => DateTime.toEpochMillis(step.now))).size > 1;
  const provided = new Map<string, string>();
  let clock: number | undefined;
  let at = 0;
  while (at < story.length) {
    const head = story[at]!;
    let end = at + 1;
    while (end < story.length && story[end]!.by !== undefined && story[end]!.after === undefined)
      end++;
    const group = story.slice(at, end);
    const now = DateTime.toEpochMillis(head.now);
    if (head.after !== undefined) {
      // A schedule: it runs when the clock reaches it.
      made.push({ _tag: "Clock", at: head.now });
      clock = now;
    } else {
      for (const context of head.context) {
        const value = literal(context.value);
        if (provided.get(context.name) === value) continue;
        provided.set(context.name, value);
        made.push({
          _tag: "Provide",
          name: context.name,
          tag: context.tag,
          value: context.value,
        });
      }
      if (timed && clock !== now) {
        made.push({ _tag: "Clock", at: head.now });
        clock = now;
      }
      made.push({ _tag: "When", aggregate: head.aggregate, id: head.id, command: head.command });
      if (head.outcome._tag === "Rejected")
        made.push({ _tag: "Rejected", rejection: head.outcome.rejection });
    }
    for (const step of group)
      for (const asked of step.asked)
        if (asked.again)
          made.push({
            _tag: "Note",
            text: `${asked.by} ${asked.step === undefined ? "handles its event" : `runs its step ${asked.step}`} a second time and asks ${asked.call} again: a story does each once, so it does not make this call`,
          });
        else made.push({ _tag: "Call", asked }, { _tag: "Answer", asked });
    for (const step of group)
      if (step.again)
        made.push({
          _tag: "Note",
          text: `${step.by} ${step.step === undefined ? "handles its event" : `runs its step ${step.step}`} a second time and sends ${tagOf(step.command)} again: a story does each once, so it does not run this step`,
        });
    const streams = new Map<string, { aggregate: string; id: string; events: Array<unknown> }>();
    for (const step of group) {
      if (step.again || step.outcome._tag !== "Accepted" || step.outcome.events.length === 0)
        continue;
      // A decision records on several instances: each one's events are its own stream's.
      for (const part of step.recorded ?? [
        { aggregate: step.aggregate, id: step.id, events: step.outcome.events },
      ]) {
        const key = `${part.aggregate}/${part.id}`;
        const stream = streams.get(key) ?? { aggregate: part.aggregate, id: part.id, events: [] };
        stream.events.push(...part.events);
        streams.set(key, stream);
      }
    }
    for (const stream of streams.values()) made.push({ _tag: "Then", ...stream });
    if (shown.length < story.length && at < shown.length && shown.length <= end)
      made.push({
        _tag: "Note",
        text: "what the report shows has happened by here: the rest is what the model does next",
      });
    at = end;
  }
  return made;
};

/**
 * Whether a story needs something a `Story` does not do: an event delivered
 * twice, a saga's step run twice, or a scheduled command that runs late.
 */
export const redelivers = (shown: Story): boolean =>
  whole(shown).some((step) => step.again || step.late);

const tagOf = (value: unknown): string => String((value as { readonly _tag?: unknown })._tag);

/** A value as TypeScript source. An instance of a class is written as its fields. */
const literal = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return String(value);
  if (Option.isOption(value))
    return Option.isSome(value) ? `Option.some(${literal(value.value)})` : "Option.none()";
  if (DateTime.isDateTime(value))
    return `DateTime.makeUnsafe(${JSON.stringify(DateTime.formatIso(value))})`;
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  const fields = Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .map(([key, field]) => `${key}: ${literal(field)}`);
  return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
};

/** A command, an event or a rejection as the code that makes it: `new Deposit({ amount: 1 })`. */
const made = (value: unknown): string => {
  const { _tag: tag, ...fields } = value as { readonly _tag: string };
  return `new ${tag}(${literal(fields)})`;
};

/**
 * A story the explorer found, as the code of a `Story` test: paste it in,
 * import what it names, and the sequence runs on the whole model in memory.
 */
export const script = (story: Story): string =>
  [
    "story(",
    ...ops(story).map((op) => {
      switch (op._tag) {
        case "Provide":
          return `  Story.provide(${op.name}, ${literal(op.value)}),`;
        case "Clock":
          return `  Story.clock(${JSON.stringify(DateTime.formatIso(op.at))}),`;
        case "When":
          return `  Story.when(${made(op.command)}),`;
        case "Rejected":
          return `  Story.rejected(${made(op.rejection)}),`;
        case "Call":
          return `  Story.call(${op.asked.call}, {}),`;
        case "Answer":
          return `  Story.${op.asked.failed ? "fail" : "succeed"}(${op.asked.call}, ${literal(op.asked.answer)}),`;
        case "Then":
          return `  Story.then(${op.aggregate}.ref(${JSON.stringify(op.id)}), ${op.events.map(made).join(", ")}),`;
        case "Note":
          return `  // ${op.text}`;
      }
    }),
    ")",
  ].join("\n");
