import * as Domain from "@alchemy.run/domain";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

export class Published extends Domain.Event("Published", {}) {}
export class Discarded extends Domain.Event("Discarded", {}) {}
export class Tagged extends Domain.Event("Tagged", { tag: Schema.String }) {}
export class Finished extends Domain.Event("Finished", {}) {}
export class Tallied extends Domain.Event("Tallied", { long: Schema.Int }) {}

export class Publish extends Domain.Command("Publish", {
  target: Schema.String,
  input: {},
  events: [Published],
}) {}

export class Discard extends Domain.Command("Discard", {
  target: Schema.String,
  input: {},
  events: [Discarded],
}) {}

export class Tag extends Domain.Command("Tag", {
  target: Schema.String,
  input: { tag: Schema.String },
  events: [Tagged],
}) {}

export class Finish extends Domain.Command("Finish", {
  target: Schema.String,
  input: {},
  events: [Finished],
}) {}

export class Tally extends Domain.Command("Tally", {
  target: Schema.String,
  input: {},
  events: [Tallied],
}) {}

const DONE = "done";

/** Written the way handlers often are: rest patterns, helpers, and locals that change. */
export class Sheet extends Domain.Aggregate("Sheet", {
  id: Schema.String,
  state: Schema.Struct({
    title: Schema.String,
    draft: Schema.optionalKey(Schema.String),
    tags: Schema.Array(Schema.String),
    counts: Schema.Struct({ open: Schema.Int, done: Schema.Int }),
    long: Schema.Int,
  }),
  initial: { title: "", tags: [], counts: { open: 0, done: 0 }, long: 0 },
  invariants: {
    LongNeverNegative: (sheet) => sheet.long >= 0,
    CountsNeverNegative: (sheet) =>
      Record.has(sheet.counts, "open") &&
      "done" in sheet.counts &&
      Object.values(sheet.counts).every((count) => count >= 0),
  },
  commands: [Publish, Discard, Tag, Finish, Tally],
  decide: {
    Publish: (state) => (state.draft == null ? [] : [new Published({})]),
    Discard: () => [new Discarded({})],
    Tag: (state, command) =>
      Arr.some(state.tags, (tag) => tag === command.tag) ? [] : [new Tagged({ tag: command.tag })],
    Finish: () => [new Finished({})],
    // Counts the long tags twice, in two ways, and records the count when they agree.
    Tally: (state) => {
      const long: Array<string> = [];
      const counts = { long: 0 };
      for (const [index, tag] of state.tags.entries()) {
        if (typeof tag !== "string" || index < 0) continue;
        if (tag.length > 3) {
          counts.long++;
          long.push(tag);
        }
      }
      return counts.long === long.length ? [new Tallied({ long: long.length })] : [];
    },
  },
  evolve: {
    Published: ({ draft, ...rest }) => ({ ...rest, title: draft ?? rest.title }),
    Discarded: (state) => Struct.omit(state, ["draft"]),
    Tagged: (state, event) => ({ ...state, tags: Arr.append(state.tags, event.tag) }),
    Finished: (state) => {
      const { [DONE]: done, ...others } = state.counts;
      return { ...state, counts: { ...others, [DONE]: done + 1 } };
    },
    Tallied: (state, event) => ({ ...state, long: event.long }),
  },
}) {}
