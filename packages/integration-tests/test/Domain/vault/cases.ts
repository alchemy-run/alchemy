import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Name = Domain.Sealed(Schema.String);

/** What each case found: `true`, or what went wrong. */
export type CaseResults = Record<string, true | string>;

/** The cases every Vault passes, whatever keeps and wraps its keys. */
export const caseNames = [
  "a sealed value opens",
  "the same value seals to a different box each time",
  "a box does not open under another subject",
  "a shredded subject's values no longer open",
  "a subject sealed for again gets a new key",
  "first seals made at once all open",
  "shredding one subject leaves another's values",
  "shredding a subject with no key is not an error",
] as const;

const check = (found: boolean, otherwise: string): true | string => (found ? true : otherwise);

/**
 * Run every case against the Vault provided, under subjects that start with
 * `prefix`. Each case shreds its subjects first, so a run can follow another
 * on a store that keeps its rows.
 */
export const runCases = Effect.fn(function* (prefix: string) {
  const vault = yield* Domain.Vault;
  const results: CaseResults = {};
  const subject = (name: string) => `${prefix}/${name}`;
  const fresh = (...names: ReadonlyArray<string>) =>
    Effect.forEach(names, (name) => vault.shred(subject(name)), { discard: true });
  const run = (name: (typeof caseNames)[number], body: Effect.Effect<true | string, unknown>) =>
    body.pipe(
      Effect.catchCause((cause) => Effect.succeed(`failed: ${String(cause)}`)),
      Effect.map((result) => {
        results[name] = result;
      }),
    );

  yield* run(
    "a sealed value opens",
    Effect.gen(function* () {
      yield* fresh("a");
      const sealed = yield* vault.seal(Name, subject("a"), "Sam");
      const opened = yield* vault.open(Name, sealed);
      return check(
        Option.getOrNull(opened) === "Sam" && !sealed.box.includes("Sam"),
        `opened ${JSON.stringify(opened)} from ${sealed.box}`,
      );
    }),
  );
  yield* run(
    "the same value seals to a different box each time",
    Effect.gen(function* () {
      yield* fresh("b");
      const first = yield* vault.seal(Name, subject("b"), "Sam");
      const second = yield* vault.seal(Name, subject("b"), "Sam");
      const both = yield* Effect.all([vault.open(Name, first), vault.open(Name, second)]);
      return check(
        first.box !== second.box && both.every((opened) => Option.getOrNull(opened) === "Sam"),
        `${first.box} and ${second.box} opened as ${JSON.stringify(both)}`,
      );
    }),
  );
  yield* run(
    "a box does not open under another subject",
    Effect.gen(function* () {
      yield* fresh("c", "d");
      const sealed = yield* vault.seal(Name, subject("c"), "Sam");
      yield* vault.seal(Name, subject("d"), "Alex");
      const opened = yield* vault.open(Name, { ...sealed, subject: subject("d") });
      return check(Option.isNone(opened), `opened ${JSON.stringify(opened)}`);
    }),
  );
  yield* run(
    "a shredded subject's values no longer open",
    Effect.gen(function* () {
      yield* fresh("e");
      const first = yield* vault.seal(Name, subject("e"), "Sam");
      const second = yield* vault.seal(Name, subject("e"), "Samuel");
      yield* vault.shred(subject("e"));
      const opened = yield* Effect.all([vault.open(Name, first), vault.open(Name, second)]);
      return check(opened.every(Option.isNone), `opened ${JSON.stringify(opened)}`);
    }),
  );
  yield* run(
    "a subject sealed for again gets a new key",
    Effect.gen(function* () {
      yield* fresh("f");
      const before = yield* vault.seal(Name, subject("f"), "Sam");
      yield* vault.shred(subject("f"));
      const after = yield* vault.seal(Name, subject("f"), "Sam");
      const opened = yield* Effect.all([vault.open(Name, before), vault.open(Name, after)]);
      return check(
        Option.isNone(opened[0]) && Option.getOrNull(opened[1]) === "Sam",
        `opened ${JSON.stringify(opened)}`,
      );
    }),
  );
  yield* run(
    "first seals made at once all open",
    Effect.gen(function* () {
      yield* fresh("g");
      const sealed = yield* Effect.forEach(
        ["one", "two", "three", "four", "five", "six"],
        (value) => vault.seal(Name, subject("g"), value),
        { concurrency: "unbounded" },
      );
      const opened = yield* Effect.forEach(sealed, (box) => vault.open(Name, box));
      return check(
        opened.map(Option.getOrNull).join() === "one,two,three,four,five,six",
        `opened ${JSON.stringify(opened)}`,
      );
    }),
  );
  yield* run(
    "shredding one subject leaves another's values",
    Effect.gen(function* () {
      yield* fresh("h", "i");
      const kept = yield* vault.seal(Name, subject("h"), "Alex");
      yield* vault.seal(Name, subject("i"), "Sam");
      yield* vault.shred(subject("i"));
      const opened = yield* vault.open(Name, kept);
      return check(Option.getOrNull(opened) === "Alex", `opened ${JSON.stringify(opened)}`);
    }),
  );
  yield* run(
    "shredding a subject with no key is not an error",
    Effect.gen(function* () {
      yield* fresh("j");
      yield* vault.shred(subject("j"));
      return true as const;
    }),
  );
  return results;
});
