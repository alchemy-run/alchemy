import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Aggregate from "../../Aggregate.ts";
import type * as Compaction from "../../Compaction.ts";
import type * as ModelSearch from "../../Explore/internal/ModelSearch.ts";
import * as Script from "../../Explore/internal/Script.ts";
import type * as Model from "../../Model.ts";
import { type Delivery, emptySnapshot, type Json, type ViewSnapshot } from "../../Platform.ts";
import type * as Rewrite from "../../Rewrite.ts";
import { loose, probe, type Probed, quietly, Story } from "../../Story.ts";
import type * as View from "../../View.ts";

/** What a run's instances and views hold where a probe looked. */
interface Seen {
  /** Each instance's encoded state, by `Aggregate/id`: `null` for one that was removed. */
  readonly states: ReadonlyMap<string, Json>;
  /** Each view key's encoded state as a view added now would build it, by `View/key`. */
  readonly rebuilt: ReadonlyMap<string, Json>;
}

/**
 * Every view of a model, built from nothing out of the events its instances
 * hold now: what a view added or rebuilt at this point reads. The instances
 * are read one after another, in the order each first committed.
 */
const rebuilt = Effect.fn(function* (model: Model.Any, probed: Probed) {
  const { kernel } = probed.internals;
  const none = () => Effect.void;
  const aggregates = new Map(
    (model.aggregates as ReadonlyArray<Aggregate.Any>).map((cls) => [cls.aggregateName, cls]),
  );
  const views = new Map(
    (model.views as ReadonlyArray<View.Any>).map((cls) => [
      cls.viewName,
      kernel.viewKit(cls, none),
    ]),
  );
  const queue: Array<Delivery> = [];
  for (const { aggregate, id } of probed.instances) {
    const cls = aggregates.get(aggregate);
    const rows = yield* (
      probed.internals.aggregates.get(aggregate)?.events?.(id) ?? Effect.succeed([])
    );
    if (!cls || rows.length === 0) continue;
    const routed = yield* kernel.aggregateKit(cls, none).replay({ id, routed: {}, rows });
    queue.push(...routed.deliveries);
  }
  const snapshots = new Map<string, ViewSnapshot>();
  for (let at = 0; at < queue.length; at++) {
    const delivery = queue[at]!;
    const kit = delivery.target.kind === "view" ? views.get(delivery.target.name) : undefined;
    if (!kit) continue;
    const key = `${delivery.target.name}/${delivery.key}`;
    const applied = yield* kit.apply(delivery.key, snapshots.get(key) ?? emptySnapshot, [delivery]);
    if (!applied.changed) continue;
    snapshots.set(key, applied.snapshot);
    queue.push(...applied.downstream);
  }
  return new Map([...snapshots].map(([key, snapshot]) => [key, snapshot.state]));
});

const look = (model: Model.Any, into: (seen: Seen) => void) =>
  probe((probed) =>
    Effect.gen(function* () {
      const states = new Map<string, Json>();
      for (const { aggregate, id } of probed.instances) {
        const store = probed.internals.aggregates.get(aggregate);
        if (store) states.set(`${aggregate}/${id}`, (yield* store.state(id)).state);
      }
      into({ states, rebuilt: yield* rebuilt(model, probed) });
    }),
  );

/** A rule about a rewrite or a compaction, as far as the runs on the real model say. */
export interface Checked {
  readonly name: string;
  readonly kind: "compaction" | "roll-up" | "rewrite";
  /** What the rule says, for a report. */
  readonly says: string;
  /** How many runs looked at it. */
  runs: number;
  /** The first run that broke it: the sequence, as a story, and what it showed. */
  broken:
    | { readonly story: ModelSearch.Story; readonly script: string; readonly shown: string }
    | undefined;
}

export interface Report {
  readonly rules: ReadonlyArray<Checked>;
  /** How many sequences were run with a rewrite or a compaction put in. */
  readonly runs: number;
  /** Whether the runs stopped at the budget before every place was tried. */
  readonly truncated: boolean;
  /** The rewrites no run gave an input: no value in a sequence fits one of their fields. */
  readonly uninstantiated: ReadonlyArray<string>;
}

/** Every value a sequence's commands and events hold, however deep. */
const leaves = (value: unknown, into: Array<unknown>): void => {
  if (value === null || value === undefined) return;
  into.push(value);
  if (typeof value !== "object" || DateTime.isDateTime(value)) return;
  for (const field of Array.isArray(value) ? value : Object.values(value)) leaves(field, into);
};

/** The most inputs one rewrite is given in one sequence. */
const MAX_INPUTS = 3;

/** Inputs for a rewrite, each field one of the values the sequence holds that its schema allows. */
const inputsOf = (
  rewrite: Rewrite.Any,
  values: ReadonlyArray<unknown>,
): ReadonlyArray<{ readonly _tag: string }> => {
  const fields = Object.entries(
    (rewrite as unknown as { readonly fields: Readonly<Record<string, Schema.Top>> }).fields,
  ).filter(([key]) => key !== "_tag");
  let made: Array<Record<string, unknown>> = [{}];
  for (const [key, schema] of fields) {
    const is = Schema.is(schema);
    const fitting: Array<unknown> = [];
    for (const value of values)
      if (is(value) && !fitting.some((other) => JSON.stringify(other) === JSON.stringify(value)))
        fitting.push(value);
    if (fitting.length === 0) return [];
    made = made
      .flatMap((given) => fitting.map((value) => ({ ...given, [key]: value })))
      .slice(0, MAX_INPUTS);
  }
  return made.flatMap((given) => {
    const built = Result.try(() => new rewrite(given));
    return Result.isSuccess(built) ? [built.success] : [];
  });
};

const literal = (value: unknown): string =>
  JSON.stringify(value, (_, field) => (typeof field === "bigint" ? `${field}n` : field));

const made = (value: { readonly _tag: string }): string => {
  const { _tag: tag, ...fields } = value;
  return `new ${tag}(${Object.keys(fields).length === 0 ? "" : literal(fields)})`;
};

export interface Options {
  /** The most sequences run with a rewrite or a compaction put in. */
  readonly budget: number;
  /** The views that may read a roll-up as something else than the events it replaces, as `View.Compaction`. */
  readonly lossy: ReadonlyArray<string>;
  /** The rewrites proved to keep every invariant: one is run only where a compaction could change what it does. */
  readonly proved: ReadonlySet<string>;
}

/**
 * Run each sequence again on the real model with a compaction, then a
 * rewrite, put in at each place a caller could have run one, and say what
 * each leaves:
 *
 * - a compaction is refused nowhere, and the sequence goes on as it did;
 * - a view built after a compaction holds what one built from the events did;
 * - a rewrite is refused nowhere, and leaves every instance in its rules;
 * - a rewrite leaves a compacted instance as it leaves one that kept its events.
 */
export const check = Effect.fn(function* (
  model: Model.Any,
  found: ReadonlyArray<{ readonly story: ModelSearch.Story }>,
  run: (...steps: ReadonlyArray<unknown>) => Effect.Effect<void, unknown>,
  stepOf: (op: Script.Op) => ReadonlyArray<unknown>,
  options: Options,
) {
  const aggregates = new Map(
    (model.aggregates as ReadonlyArray<Aggregate.Any>).map((cls) => [cls.aggregateName, cls]),
  );
  const compactions = (model.definitions.compactions ?? []) as ReadonlyArray<Compaction.Any>;
  const rewrites = (model.definitions.rewrites ?? []) as ReadonlyArray<Rewrite.Any>;
  const rules = new Map<string, Checked>();
  const rule = (name: string, kind: Checked["kind"], says: string): Checked => {
    let found = rules.get(name);
    if (!found) rules.set(name, (found = { name, kind, says, runs: 0, broken: undefined }));
    return found;
  };
  for (const compaction of compactions) {
    rule(compaction.compactionName, "compaction", "is refused by no instance, and changes none");
  }
  for (const rewrite of rewrites) {
    rule(rewrite.rewriteName, "rewrite", "is refused by no instance, and leaves each in its rules");
    for (const compaction of compactions)
      if (compaction.definition.of === rewrite.definition.of)
        rule(
          `${rewrite.rewriteName}.${compaction.compactionName}`,
          "rewrite",
          "leaves a compacted instance as it leaves one that kept its events",
        );
  }
  /** Each view's `initial`, encoded: a key no event reached reads as it. */
  const initials = new Map<string, string>();
  for (const view of model.views as ReadonlyArray<View.Any>) {
    const state = view.definition.state as Schema.Top | undefined;
    if (!state) continue;
    const encoded = Result.try(() =>
      Schema.encodeUnknownSync(
        Schema.toCodecJson(state) as unknown as Schema.Codec<unknown, unknown>,
      )(view.definition.initial),
    );
    if (Result.isSuccess(encoded)) initials.set(view.viewName, JSON.stringify(encoded.success));
  }
  const instantiated = new Set<string>();
  /** The rewrites some sequence left an instance for. */
  const wanted = new Set<string>();
  let runs = 0;
  let truncated = false;

  const attempt = (steps: ReadonlyArray<unknown>) =>
    Effect.suspend(() => run(...steps)).pipe(
      Effect.result,
      Effect.map((result) =>
        Result.isSuccess(result)
          ? undefined
          : String((result.failure as { readonly message?: unknown }).message ?? result.failure),
      ),
    );

  /** The real invariant of an aggregate that an encoded state breaks, if any. */
  const breaks = (name: string, state: Json): string | undefined => {
    const cls = aggregates.get(name);
    if (!cls || state === null) return undefined;
    const decoded = Schema.decodeUnknownResult(
      Schema.toCodecJson(cls.definition.state as Schema.Top) as unknown as Schema.Codec<
        unknown,
        unknown
      >,
    )(state);
    if (Result.isFailure(decoded)) return "the state's schema";
    for (const [invariant, holds] of Object.entries(
      (cls.definition.invariants ?? {}) as unknown as Record<string, (state: unknown) => boolean>,
    ))
      if (!holds(decoded.success)) return invariant;
    return undefined;
  };

  for (const { story } of found) {
    if (compactions.length === 0 && rewrites.length === 0) break;
    const ops = Script.ops(story);
    const lines = Script.script(story).split("\n");
    /** The story with the lines of the steps put in before the op at `at`: each op is one line, after `story(`. */
    const scriptWith = (at: number, extra: ReadonlyArray<string>) =>
      [
        ...lines.slice(0, at + 1),
        ...extra.map((line) => `  ${line},`),
        ...lines.slice(at + 1),
      ].join("\n");
    const strict = (from: number, to: number) => ops.slice(from, to).flatMap(stepOf);
    const values: Array<unknown> = [];
    for (const op of ops) {
      if (op._tag === "When") leaves(op.command, values);
      if (op._tag === "Then") {
        values.push(op.id);
        leaves(op.events, values);
      }
    }
    // Where a caller could have run one: before each command, and at the end.
    const places = [
      ops.length,
      ...ops.flatMap((op, index) => (op._tag === "When" && index > 0 ? [index] : [])).reverse(),
    ];
    let base: Seen | undefined;
    for (const at of places) {
      const held = new Map<string, { readonly aggregate: string; readonly id: string }>();
      for (const op of ops.slice(0, at))
        if (op._tag === "Then" && op.events.length > 0)
          held.set(`${op.aggregate}/${op.id}`, { aggregate: op.aggregate, id: op.id });
      for (const instance of held.values()) {
        const cls = aggregates.get(instance.aggregate);
        if (!cls) continue;
        const ref = Aggregate.makeRef(cls, instance.id as never);
        const refText = `${instance.aggregate}.ref(${JSON.stringify(instance.id)})`;
        const stream = `${instance.aggregate}/${instance.id}`;

        for (const compaction of compactions) {
          if (compaction.definition.of !== cls) continue;
          if (runs >= options.budget) {
            truncated = true;
            break;
          }
          const name = compaction.compactionName;
          const script = scriptWith(at, [`Story.compact(${refText}, ${name})`]);
          if (base === undefined) {
            let seen: Seen | undefined;
            yield* attempt([...strict(0, ops.length), look(model, (s) => (seen = s))]);
            base = seen ?? { states: new Map(), rebuilt: new Map() };
          }
          let seen: Seen | undefined;
          runs++;
          const failure = yield* attempt([
            ...strict(0, at),
            quietly(Story.compact(ref, compaction)),
            ...strict(at, ops.length),
            look(model, (s) => (seen = s)),
          ]);
          const own = rule(name, "compaction", "");
          own.runs++;
          if (failure !== undefined) {
            own.broken ??= { story, script, shown: failure.trim() };
            continue;
          }
          if (!seen) continue;
          for (const [key, state] of seen.states) {
            const was = base.states.get(key);
            if (was === undefined || JSON.stringify(was) === JSON.stringify(state)) continue;
            own.broken ??= {
              story,
              script,
              shown: `${key} ends as ${JSON.stringify(state)}, and as ${JSON.stringify(was)} without the compaction`,
            };
          }
          for (const key of new Set([...seen.rebuilt.keys(), ...base.rebuilt.keys()])) {
            const view = key.slice(0, key.indexOf("/"));
            const about = rule(
              `${view}.${name}`,
              "roll-up",
              "built after the compaction, the view holds what it does built from the events",
            );
            about.runs++;
            const now = seen.rebuilt.get(key) ?? null;
            const was = base.rebuilt.get(key) ?? null;
            // A key with nothing folded into it holds the view's initial state.
            const text = (state: Json) =>
              state === null ? (initials.get(view) ?? "null") : JSON.stringify(state);
            if (text(now) === text(was)) continue;
            about.broken ??= {
              story,
              script,
              shown: `${view}(${key.slice(view.length + 1)}) built after the compaction holds ${JSON.stringify(now)}, and ${JSON.stringify(was)} built from the events`,
            };
          }
        }

        for (const rewrite of rewrites) {
          if (rewrite.definition.of !== cls) continue;
          if (
            options.proved.has(rewrite.rewriteName) &&
            !compactions.some((compaction) => compaction.definition.of === cls)
          )
            continue;
          wanted.add(rewrite.rewriteName);
          for (const input of inputsOf(rewrite, values)) {
            if (runs >= options.budget) {
              truncated = true;
              break;
            }
            instantiated.add(rewrite.rewriteName);
            const name = rewrite.rewriteName;
            const line = `Story.rewrite(${refText}, ${made(input)})`;
            const own = rule(name, "rewrite", "");
            let after: Seen | undefined;
            let end: Seen | undefined;
            runs++;
            own.runs++;
            // What comes after the rewrite meets other states: its commands are sent, and nothing is expected of them.
            yield* attempt([
              ...strict(0, at),
              quietly(Story.rewrite(ref, input)),
              look(model, (s) => (after = s)),
              loose,
              ...ops
                .slice(at)
                .filter((op) => op._tag !== "Then" && op._tag !== "Rejected")
                .flatMap(stepOf),
              look(model, (s) => (end = s)),
            ]);
            if (!after) {
              // The steps before it ran as they did without it: the rewrite is what failed.
              const failure = yield* attempt([
                ...strict(0, at),
                quietly(Story.rewrite(ref, input)),
              ]);
              own.broken ??= {
                story,
                script: scriptWith(at, [line]),
                shown: (failure ?? "the rewrite did not run").trim(),
              };
              continue;
            }
            for (const seen of [after, ...(end ? [end] : [])])
              for (const [key, state] of seen.states) {
                const broken = breaks(key.slice(0, key.indexOf("/")), state);
                if (broken === undefined) continue;
                own.broken ??= {
                  story,
                  script: scriptWith(at, [line]),
                  shown: `${key} is left as ${JSON.stringify(state)}, which breaks ${broken}`,
                };
              }
            for (const compaction of compactions) {
              if (compaction.definition.of !== cls) continue;
              if (runs >= options.budget) {
                truncated = true;
                break;
              }
              const both = rule(`${name}.${compaction.compactionName}`, "rewrite", "");
              const script = scriptWith(at, [
                `Story.compact(${refText}, ${compaction.compactionName})`,
                line,
              ]);
              let compacted: Seen | undefined;
              runs++;
              both.runs++;
              const failure = yield* attempt([
                ...strict(0, at),
                quietly(Story.compact(ref, compaction)),
                quietly(Story.rewrite(ref, input)),
                look(model, (s) => (compacted = s)),
              ]);
              if (failure !== undefined || !compacted) {
                both.broken ??= {
                  story,
                  script,
                  shown: (failure ?? "the rewrite did not run").trim(),
                };
                continue;
              }
              const kept = after.states.get(stream) ?? null;
              const rolled = compacted.states.get(stream) ?? null;
              if (JSON.stringify(kept) !== JSON.stringify(rolled))
                both.broken ??= {
                  story,
                  script,
                  shown: `${stream} is left as ${JSON.stringify(rolled)} once compacted, and as ${JSON.stringify(kept)} with its events: give ${name} a handler for the roll-up that says the same`,
                };
            }
          }
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  const report: Report = {
    rules: [...rules.values()].map((checked) =>
      checked.broken && checked.kind === "roll-up" && options.lossy.includes(checked.name)
        ? { ...checked, broken: undefined, runs: 0 }
        : checked,
    ),
    runs,
    truncated,
    uninstantiated: rewrites
      .map((rewrite) => rewrite.rewriteName)
      .filter((name) => wanted.has(name) && !instantiated.has(name)),
  };
  return report;
});
