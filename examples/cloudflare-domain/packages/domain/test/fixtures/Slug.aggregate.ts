import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

// The usual ways to take a part of an id an input holds: before a separator,
// after one, and the parts between them.

export class Named extends Domain.Event("Named", { name: Schema.String }) {}
export class Versioned extends Domain.Event("Versioned", { version: Schema.String }) {}
export class Counted extends Domain.Event("Counted", { parts: Schema.Int }) {}

const input = { target: Schema.String, ref: Schema.String };
const command = <Tag extends string>(tag: Tag) =>
  Domain.Command(tag, { input, events: [Named, Versioned, Counted] });

export class BySlice extends command("BySlice") {}
export class BySplit extends command("BySplit") {}
export class ByFirstOfSplit extends command("ByFirstOfSplit") {}
export class ByLastIndex extends command("ByLastIndex") {}
export class ByFixedSlice extends command("ByFixedSlice") {}
export class BySliceUnguarded extends command("BySliceUnguarded") {}
export class ByWord extends command("ByWord") {}
export class AfterSlice extends command("AfterSlice") {}
export class AfterLastIndex extends command("AfterLastIndex") {}
export class AfterSplit extends command("AfterSplit") {}
export class AfterFirstOnly extends command("AfterFirstOnly") {}
export class CountParts extends command("CountParts") {}
export class SecondPart extends command("SecondPart") {}

const named = (name: string) => [new Named({ name })];
const versioned = (version: string) => [new Versioned({ version })];

export class Slug extends Domain.Aggregate("Slug", {
  id: Schema.String,
  state: Schema.Struct({ name: Schema.String, version: Schema.String, parts: Schema.Int }),
  initial: { name: "", version: "", parts: 1 },
  commands: [
    BySlice,
    BySplit,
    ByFirstOfSplit,
    ByLastIndex,
    ByFixedSlice,
    BySliceUnguarded,
    ByWord,
    AfterSlice,
    AfterLastIndex,
    AfterSplit,
    AfterFirstOnly,
    CountParts,
    SecondPart,
  ],
  keyOf: (c) => c.target,
  decide: {
    BySlice: (_s, c) => (c.ref.includes("@") ? named(c.ref.slice(0, c.ref.indexOf("@"))) : []),
    BySplit: (_s, c) => named(c.ref.split("@")[0]!),
    ByFirstOfSplit: (_s, c) => {
      const [name] = c.ref.split("@");
      return named(name!);
    },
    // Before the last separator there may be another: the rule does not hold.
    ByLastIndex: (_s, c) =>
      c.ref.includes("@") ? named(c.ref.slice(0, c.ref.lastIndexOf("@"))) : [],
    ByFixedSlice: (_s, c) => (c.ref.startsWith("ab") ? named(c.ref.slice(0, 2)) : []),
    // With no separator, `indexOf` gives -1 and `slice` drops the last character: still none in it.
    BySliceUnguarded: (_s, c) => named(c.ref.slice(0, c.ref.indexOf("@"))),
    // A separator of several characters: what is before `@@` may hold an `@`.
    ByWord: (_s, c) => (c.ref.includes("@@") ? named(c.ref.slice(0, c.ref.indexOf("@@"))) : []),
    // After the first separator there may be another: the rule does not hold.
    AfterSlice: (_s, c) =>
      c.ref.includes("@") ? versioned(c.ref.slice(c.ref.indexOf("@") + 1)) : [],
    AfterLastIndex: (_s, c) =>
      c.ref.includes("@") ? versioned(c.ref.slice(c.ref.lastIndexOf("@") + 1)) : [],
    AfterSplit: (_s, c) => versioned(c.ref.split("@").at(-1)!),
    AfterFirstOnly: (_s, c) =>
      c.ref.indexOf("@") === c.ref.lastIndexOf("@") && c.ref.includes("@")
        ? versioned(c.ref.slice(c.ref.indexOf("@") + 1))
        : [],
    CountParts: (_s, c) => [new Counted({ parts: c.ref.split("@").length })],
    SecondPart: (_s, c) => {
      const parts = c.ref.split("@");
      return parts.length === 2 ? versioned(parts[1]!) : [];
    },
  },
  events: [Named, Versioned, Counted],
  evolve: {
    Named: (slug, e) => ({ ...slug, name: e.name }),
    Versioned: (slug, e) => ({ ...slug, version: e.version }),
    Counted: (slug, e) => ({ ...slug, parts: e.parts }),
  },
  invariants: {
    NameHasNoAt: (slug) => !slug.name.includes("@"),
    VersionHasNoAt: (slug) => !slug.version.includes("@"),
    AtLeastOnePart: (slug) => slug.parts >= 1,
  },
}) {}
