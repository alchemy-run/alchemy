import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { Group } from "./cases.ts";

// Every function of the library the prover reads, in every way it is called,
// on a grid of inputs. `conformance/cases.ts` is the table; this writes one
// aggregate for each group of it, has the prover read the aggregate, and has
// the real code run on inputs of every path. Each expression is read on
// inputs the prover knows and on inputs the solver holds, pinned to the same
// values: the result has to be the real one both ways.

/** How many expressions one command computes. Fewer keeps the paths of a branching one apart. */
const CHUNK = 8;

const MODULES = [
  ...["Array", "BigDecimal", "Boolean", "Brand", "Cause", "Chunk", "Data", "DateTime", "Duration"],
  ...[
    "Effect",
    "Equal",
    "Equivalence",
    "Exit",
    "Filter",
    "HashMap",
    "HashSet",
    "Iterable",
    "Match",
  ],
  ...["MutableHashMap", "MutableHashSet", "MutableRef", "Number", "Optic", "Option", "Order"],
  ...["Ordering", "Predicate", "Rational", "Record", "Redacted", "Ref", "Result", "Schema", "Sink"],
  ...["Stream", "String", "Struct", "Tuple", "UndefinedOr"],
];

export const PRELUDE = [
  "// @ts-nocheck",
  `import * as Domain from "@alchemy.run/domain";`,
  ...MODULES.map((module) => `import * as ${module} from "effect/${module}";`),
  `import * as BigInts from "effect/BigInt";`,
  ...[
    ...["ByteSize", "Bytes", "Clock", "Combiner", "Console", "Cron", "Formatter", "Glob"],
    ...["Inspectable", "JsonPatch", "JsonPointer", "LogLevel", "Newtype", "NonEmptyIterable"],
    ...["PrimaryKey", "Reducer", "RegExp", "SemVer", "SemVerRange", "TextDiff", "Trie"],
  ].map((module) => `import * as ${module} from "effect/${module}";`),
  `import { absurd, hole, SK } from "effect/Function";`,
  `import { apply, cast, compose, constant, constFalse, constNull, constTrue, constUndefined, constVoid, dual, flip, flow, identity, memoize, memoizeIdempotent, pipe, satisfies, tupled, untupled } from "effect/Function";`,
  `const Small = Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 }));`,
  `export class Done extends Domain.Event("Done", { results: Schema.Unknown }) {}`,
  `export class Odd extends Data.TaggedError("Odd")<{ readonly n: number }> {}`,
  `export class Negative extends Data.TaggedError("Negative")<{ readonly n: number }> {}`,
  `export class Point extends Data.Class<{ readonly x: number; readonly y: number }> {}`,
  `export class Circle extends Data.TaggedClass("Circle")<{ readonly radius: number }> {}`,
  `const Shape = Data.taggedEnum();`,
  `const even = (n) => (n % 2 === 0 ? Effect.succeed(n) : Effect.fail(new Odd({ n })));`,
  `const positive = (n) => (n >= 0 ? Effect.succeed(n) : Effect.fail(new Negative({ n })));`,
  `const halved = (n) => (n % 2 === 0 ? Result.succeed(n * 3) : Result.fail("odd"));`,
  `const byN = Order.mapInput(Order.Number, (pair) => pair.n);`,
  `const third = Rational.makeUnsafe(1n, 3n);`,
  `const ratio = (n) => Rational.fromBigInt(BigInt(n));`,
  `const fee = BigDecimal.fromStringUnsafe("2.5");`,
  `const decimal = (n) => BigDecimal.fromNumberUnsafe(n);`,
  `const noon = DateTime.makeUnsafe(43200000);`,
];

interface Chunk {
  readonly command: string;
  readonly known: boolean;
  readonly expressions: ReadonlyArray<string>;
  /** What the report has to say, for a command the prover is not to read. */
  readonly unread?: RegExp;
  /** A misuse: reported, or read and compared, whichever the prover does. */
  readonly misuse?: boolean;
}

export const chunksOf = (group: Group): ReadonlyArray<Chunk> => {
  const out: Array<Chunk> = [];
  const add = (expressions: ReadonlyArray<string>, modes: ReadonlyArray<boolean>) => {
    const size = group.chunk ?? CHUNK;
    for (let at = 0; at < expressions.length; at += size)
      for (const known of modes)
        out.push({
          command: `${group.name}${out.length}${known ? "Known" : "Held"}`,
          known,
          expressions: expressions.slice(at, at + size),
        });
  };
  add(group.both, [true, false]);
  add(group.known ?? [], [true]);
  // One command for each form the prover is not to read, on inputs the solver holds.
  for (const [expression, unread] of group.unread ?? [])
    out.push({
      command: `${group.name}${out.length}Unread`,
      known: false,
      expressions: [expression],
      unread,
    });
  for (const expression of group.misuse ?? [])
    out.push({
      command: `${group.name}${out.length}Misuse`,
      known: false,
      expressions: [group.effectful ? expression : `[${expression}].length`],
      misuse: true,
    });
  return out;
};

/** What a file that imports none of the library's modules starts with. */
const BARE = [
  "// @ts-nocheck",
  `import * as Domain from "@alchemy.run/domain";`,
  `import * as Schema from "effect/Schema";`,
  `import * as Effect from "effect/Effect";`,
  `const Small = Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 }));`,
  `export class Done extends Domain.Event("Done", { results: Schema.Unknown }) {}`,
];

export const sourceOf = (group: Group, chunks: ReadonlyArray<Chunk>): string =>
  [
    ...(group.bare ? BARE : PRELUDE),
    ...(group.prelude ?? []),
    `const PINS = ${group.pins};`,
    `const input = { id: Schema.String, pick: Schema.Literals(PINS.map((_, index) => index)), ${group.input} };`,
    ...chunks.map(
      ({ command }) =>
        `export class ${command} extends Domain.Command("${command}", { input, events: [Done] }) {}`,
    ),
    `export class Bench extends Domain.Aggregate("Bench", {`,
    `  id: Schema.String,`,
    `  state: Schema.Struct({ runs: Schema.Int }),`,
    `  initial: { runs: 0 },`,
    `  invariants: { NeverBelowZero: (bench) => bench.runs >= 0 },`,
    `  commands: [${chunks.map(({ command }) => command).join(", ")}],`,
    `  keyOf: (command) => command.id,`,
    `  decide: {`,
    ...chunks.map(({ command, known, expressions }) => {
      const results = expressions
        .map(
          (expression, index) =>
            `r${index}: ${group.effectful ? `yield* (${expression})` : `(${expression})`}`,
        )
        .join(", ");
      const body = `const pin = PINS[command.pick]; if (${group.differs}) return []; ${group.bind(known)} return [new Done({ results: { ${results} } })];`;
      return group.effectful
        ? `    ${command}: Effect.fn(function* (_bench, command) { ${body} }),`
        : `    ${command}: (_bench, command) => { ${body} },`;
    }),
    `  },`,
    `  evolve: { Done: (bench) => ({ runs: bench.runs + 1 }) },`,
    `}) {}`,
  ].join("\n");

/** One test for each group: its aggregate is written, read and compared. */
export const check = (groups: ReadonlyArray<Group>): void => {
  for (const group of groups)
    it.effect(
      `${group.name}: every expression is what the real code gives, on known inputs and on held ones`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const chunks = chunksOf(group);
          const directory = yield* path.fromFileUrl(new URL("./", import.meta.url));
          const file = path.join(directory, `${group.name}.generated.aggregate.ts`);
          yield* fs.writeFileString(file, sourceOf(group, chunks));
          yield* Effect.addFinalizer(() =>
            process.env.KEEP_GENERATED ? Effect.void : Effect.ignore(fs.remove(file)),
          );
          const url = yield* path.toFileUrl(file);
          const fixture: {
            readonly Bench: Parameters<typeof Prove.report>[0];
            readonly [name: string]: unknown;
          } = yield* Effect.promise(() => import(/* @vite-ignore */ url.href));
          const report = yield* Prove.report(fixture.Bench, {
            source: url,
            opaque: (group.opaque ?? []).map(
              (name) => fixture[name] as (...args: ReadonlyArray<never>) => unknown,
            ),
          });
          if (process.env.CONFORMANCE_DUMP)
            yield* fs.writeFileString(
              path.join(process.env.CONFORMANCE_DUMP, `probe-${group.name}.json`),
              JSON.stringify(
                {
                  agreement: report.agreement,
                  unread: report.unread,
                  commands: report.commands,
                  chunks,
                },
                (_, value) => (typeof value === "bigint" ? String(value) : value),
                1,
              ),
            );
          // What was not read, with the expressions the command computes.
          const stopped = new Map(
            chunks.flatMap((chunk) => (chunk.unread ? [[chunk.command, chunk]] : [])),
          );
          // A form the prover does not read is reported, with the reason the table gives.
          const misreported = report.commands.flatMap((command) => {
            const chunk = stopped.get(command.command);
            if (!chunk?.unread) return [];
            const reason = "reason" in command.schema ? command.schema.reason : "";
            return command.schema._tag === "NotTranslated" && chunk.unread.test(reason)
              ? []
              : [{ expression: chunk.expressions[0], verdict: command.schema._tag, reason }];
          });
          expect(misreported).toEqual([]);
          const misused = new Set(chunks.flatMap((chunk) => (chunk.misuse ? [chunk.command] : [])));
          const unread = report.commands.flatMap((command) =>
            command.schema._tag === "Proved" ||
            command.schema._tag === "Bounded" ||
            stopped.has(command.command) ||
            misused.has(command.command)
              ? []
              : [
                  {
                    command: command.command,
                    verdict: command.schema._tag,
                    reason: "reason" in command.schema ? command.schema.reason : undefined,
                    expressions: chunks.find((chunk) => chunk.command === command.command)
                      ?.expressions,
                  },
                ],
          );
          expect(unread).toEqual([]);
          // A misuse TypeScript would refuse may throw in the real code where the prover read on: that is all it may do.
          const thrownByMisuse = (reason: string) =>
            [...misused].some((command) => reason.includes(`read ${command} `)) &&
            reason.includes("and the real code threw: ");
          expect(
            report.agreement.differs
              .filter((reason) => !thrownByMisuse(reason))
              .map((reason) => reason.slice(0, 400)),
          ).toEqual([]);
          // A path that takes the items of a hash set in an order the real one does not give
          // cannot be run: the order the real one gives is compared on its own path.
          // A misuse the real code cannot run to its end is not compared: the prover reported it, or read it as a value.
          if (misused.size === 0)
            expect(report.agreement.uncompared - report.agreement.unordered).toBe(0);
          if (chunks.some((chunk) => !chunk.unread && !chunk.misuse))
            expect(report.agreement.compared).toBeGreaterThan(0);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      600_000,
    );
};
