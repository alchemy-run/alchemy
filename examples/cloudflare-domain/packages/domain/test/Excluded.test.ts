import * as Prove from "@alchemy.run/domain/Prove";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// The modules of Effect the prover reads: by a model of its own, or by
// running a pure function on values the code writes. Every other module is
// left out on purpose, and this checks that nothing in one is read by
// accident: a call to any function of any of them is reported, by name.

const READ = new Set([
  ...["Array", "BigDecimal", "BigInt", "Boolean", "Brand", "ByteSize", "Cause", "Chunk"],
  ...["Clock", "Console", "Cron", "Data", "DateTime", "Duration", "Effect", "Equal"],
  ...["Equivalence", "Exit", "Filter", "Formatter", "Function", "Glob", "HashMap", "HashSet"],
  ...["Inspectable", "Iterable", "JsonPatch", "JsonPointer", "LogLevel", "Match", "MutableHashMap"],
  ...["MutableHashSet", "MutableRef", "Newtype", "NonEmptyIterable", "Number", "Optic", "Option"],
  ...["Order", "Ordering", "Predicate", "PrimaryKey", "Rational", "Record", "Redacted"],
  ...["Ref", "RegExp", "Result", "SemVer", "SemVerRange", "Sink", "Stream", "String", "Struct"],
  ...["SubscriptionRef", "Symbol", "SynchronizedRef", "TextDiff", "Trie", "Tuple", "UndefinedOr"],
  ...["Cache", "Deferred", "Fiber", "FiberHandle", "FiberMap", "FiberSet", "Latch", "Pool"],
  ...["PubSub", "Queue", "Request", "RequestResolver", "Schedule"],
  ...["PartitionedSemaphore", "ScopedCache", "Semaphore", "TxChunk", "TxDeferred", "TxPubSub"],
  ...["TxHashMap", "TxHashSet", "TxPriorityQueue", "TxQueue", "Channel", "Pull", "Take"],
  ...["Combiner", "Reducer", "MutableList", "Scope", "ScopedRef", "RcRef", "RcMap", "Resource"],
  "Random",
  "Metric",
  "Hash",
  "Graph",
  "HashRing",
  "Bytes",
  "Layer",
  "Context",
  ...["TxReentrantLock", "TxRef", "TxSemaphore", "TxSubscriptionRef", "index"],
]);

const NAME = /^[A-Za-z_$][\w$]*$/;

it.effect(
  "no function of a module the prover leaves out is read",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const library = path.dirname(
        yield* path.fromFileUrl(new URL(import.meta.resolve("effect/Array"))),
      );
      const modules = (yield* fs.readDirectory(library))
        .filter((file) => file.endsWith(".js"))
        .map((file) => file.slice(0, -3))
        .filter((name) => !READ.has(name))
        .sort();
      const calls: Array<readonly [command: string, module: string, name: string]> = [];
      for (const module of modules) {
        const loaded: Record<string, unknown> = yield* Effect.promise(
          () => import(/* @vite-ignore */ `effect/${module}`),
        );
        for (const [index, name] of Object.keys(loaded)
          .filter((key) => NAME.test(key))
          .entries())
          calls.push([`C${module}_${index}`, module, name]);
      }
      // One command for each function, whose handler calls it and uses what it gives.
      const source = [
        "// @ts-nocheck",
        `import * as Domain from "@alchemy.run/domain";`,
        `import * as Schema from "effect/Schema";`,
        ...modules
          .filter((module) => module !== "Schema")
          .map((module) => `import * as ${module} from "effect/${module}";`),
        `export class Seen extends Domain.Event("Seen", {}) {}`,
        ...calls.map(
          ([command]) =>
            `export class ${command} extends Domain.Command("${command}", { input: { id: Schema.String }, events: [Seen] }) {}`,
        ),
        `export class Excluded extends Domain.Aggregate("Excluded", {`,
        `  id: Schema.String,`,
        `  state: Schema.Struct({ n: Schema.Int }),`,
        `  initial: { n: 0 },`,
        `  invariants: { Fine: (state) => state.n >= 0 },`,
        `  commands: [${calls.map(([command]) => command).join(", ")}],`,
        `  keyOf: (command) => command.id,`,
        `  decide: {`,
        ...calls.map(
          ([command, module, name]) =>
            `    ${command}: () => { const made = ${module}.${name}(); return made === 1 ? [] : [new Seen({})]; },`,
        ),
        `  },`,
        `  evolve: { Seen: (state) => state },`,
        `}) {}`,
      ].join("\n");
      const directory = yield* path.fromFileUrl(new URL("./fixtures/", import.meta.url));
      const file = path.join(directory, "Excluded.generated.aggregate.ts");
      yield* fs.writeFileString(file, source);
      yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(file)));
      const url = yield* path.toFileUrl(file);
      const fixture: { readonly Excluded: Parameters<typeof Prove.report>[0] } =
        yield* Effect.promise(() => import(/* @vite-ignore */ url.href));
      const report = yield* Prove.report(fixture.Excluded, { source: url });
      const verdicts = new Map(report.commands.map((command) => [command.command, command.schema]));
      const read = calls.flatMap(([command, module, name]) => {
        const verdict = verdicts.get(command);
        return verdict?._tag === "NotTranslated" ? [] : [`${module}.${name}: ${verdict?._tag}`];
      });
      expect(read).toEqual([]);
      // Most are reported as a call with no model; a schema is built, and what it gives cannot be used.
      const reasons = new Set(
        calls.map(([command, module, name]) => {
          const verdict = verdicts.get(command);
          return verdict?._tag === "NotTranslated"
            ? verdict.reason.replace(`${module}.${name}`, "M.f")
            : "";
        }),
      );
      expect([...reasons].sort()).toEqual([
        // A function of `Schema` a handler may call, called here with nothing.
        "M.f is called in a way the prover has no model for",
        "calls M.f, which the prover has no model for",
        "compares values the prover does not model",
      ]);
      expect(modules.length).toBeGreaterThan(35);
      expect(calls.length).toBeGreaterThan(1000);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  300_000,
);
