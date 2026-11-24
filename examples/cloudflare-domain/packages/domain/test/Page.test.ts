import { forms, surface } from "@alchemy.run/domain/Prove/Surface";
import { expect, it } from "@effect/vitest";
import { type Group, groups } from "./conformance/cases.ts";
import {
  type Block,
  type Section,
  blocksOf,
  linesOf,
  supported,
  tabled,
  unsupported,
} from "./conformance/docs.ts";
import { PRELUDE, check } from "./conformance/run.ts";

// The page "What can be verified" says what is supported, as code. This holds
// the page to the prover:
//
// - a line under "Library functions" is a line of a conformance table, or a part of one;
// - a "Supported" block is run through the prover and the real code, which have to agree;
// - each line of a "Not supported" block is reported;
// - every function the prover has a model for is on the page.
//
// A line added to the page is tested by being there, and one that is wrong fails here.

const page = new URL(
  "../../../../../website/src/content/docs/domain/verifiable-code.mdx",
  import.meta.url,
).pathname;
const blocks = blocksOf(page);

const base = (name: string): Section["base"] => {
  const group = groups.find((each) => each.name === name);
  if (!group) throw new Error(`no table is named ${name}`);
  return { input: group.input, pins: group.pins, differs: group.differs, bind: group.bind };
};

const numbers = base("Number");
const lists = base("Array");
const MODEL = [
  `export class Started extends Domain.Event("Started", {}) {}`,
  `export class Overweight extends Data.TaggedError("Overweight")<{ readonly over: number }> {}`,
];

/** The sections whose blocks are run, and what the names their lines use stand for. */
const sections: Readonly<Record<string, Section>> = {
  Statements: {
    base: lists,
    chunk: 100,
    context: `const resource = { n: a };`,
    // An object of a class is not a value an event carries.
    quiet: /^const local/,
  },
  Expressions: {
    base: numbers,
    context: `const text = "t"; const items = [a, b, 3]; const made = { n: a }; const maybe = flag ? { n: b, twice: (n) => n * 2 } : undefined; const callback = flag ? (n) => n + 1 : undefined; const record = { x: 1, z: a, inner: { deep: b }, more: 2 }; const twice = (n) => n * 2; const tag = (parts, value) => value;`,
    prelude: MODEL,
    quiet: /^new Started|^Started\.make|^maybe \?\? b|^\(\{ \.\.\.made/,
  },
  Numbers: { base: numbers },
  Decimals: {
    base: base("BigDecimal"),
    context: `const fee = BigDecimal.sum(amount, BigDecimal.fromStringUnsafe("1.5")); const RATE = BigDecimal.fromStringUnsafe("0.25");`,
  },
  Strings: { base: base("Cut"), context: `const other = text.slice(0, 1);`, chunk: 3 },
  Lists: { base: lists, context: `const made = { n: a, m: 1 }; const b = a + 1;` },
  "Hash sets and hash maps": {
    base: base("HashSet"),
    context: `const person = a; const roster = { members, points: HashMap.make([a, 1], [a + 1, 2]) }; const other = { members: HashSet.add(members, a) }; const seen = [];`,
    chunk: 3,
  },
  "Effects and failures": {
    base: numbers,
    prelude: [
      `import * as Schedule from "effect/Schedule";`,
      `import * as Deferred from "effect/Deferred";`,
    ],
    context: `const url = "https://example.com";`,
    // A cell is not a value an event carries.
    quiet: /^const tries|^const answer|^yield\* Effect\.forkChild/,
    effectful: true,
  },
  Streams: {
    base: lists,
    prelude: [`import * as Queue from "effect/Queue";`],
    context: `const command = { readings: items, count: a }; const stream = Stream.fromIterable(items); const first = stream; const second = stream; const checked = (reading) => Effect.succeed(reading + 1); const paced = (millis, ...items) => Stream.fromIterable(items).pipe(Stream.mapEffect((item) => Effect.as(Effect.sleep(millis), item))); const options = { cost: () => 1, units: 1, duration: 1 }; const b = a + 1; const queue = yield* Queue.unbounded();`,
    effectful: true,
    // A stream does nothing until it is run.
    runs: (line) =>
      line.includes("Stream.run") ? `yield* (${line})` : `yield* Stream.runCollect(${line})`,
  },
  "Not supported": {
    base: numbers,
    prelude: [
      `import * as Schedule from "effect/Schedule";`,
      `import * as SubscriptionRef from "effect/SubscriptionRef";`,
      `import * as Fiber from "effect/Fiber";`,
      `import * as Deferred from "effect/Deferred";`,
      `import * as Latch from "effect/Latch";`,
      `import * as Queue from "effect/Queue";`,
      `import * as Semaphore from "effect/Semaphore";`,
      `import * as Cache from "effect/Cache";`,
      `import * as Request from "effect/Request";`,
      `import * as Random from "effect/Random";`,
      `import * as Metric from "effect/Metric";`,
    ],
    context: `const url = "https://example.com"; const effect = Effect.succeed(a); const first = effect; const second = effect; const command = { attempts: a, item: a }; const cron = Cron.parseUnsafe("0 4 * * *"); const Ticket = Schema.Struct({ n: Schema.Number }); const input = { n: a }; const ticket = input; const cell = yield* SubscriptionRef.make(a); const done = yield* Deferred.make(); const gate = yield* Latch.make(); const line = yield* Queue.unbounded(); const permits = yield* Semaphore.make(2); const prices = yield* Cache.make({ capacity: 2, lookup: (n) => Effect.succeed(n) }); const GetPrice = Request.tagged("GetPrice"); const orders = Metric.counter("orders");`,
    effectful: true,
  },
};

/** Blocks that are not run here, each with the test that holds what it shows. */
const ELSEWHERE: ReadonlyArray<readonly [heading: string, title: RegExp, why: string]> = [
  ["Schemas", /^/, "the state, a command and an event of every shape: Shapes.test.ts"],
  [
    "Effects and failures",
    /^Supported$/,
    "one handler: each form of it is in the Generators, Effect and Services tables",
  ],
  ["Your own files", /^/, "Modules.test.ts"],
  ["Your own packages", /^/, "Modules.test.ts"],
  ["Opaque functions", /^/, "the Opaque table"],
  ["What a handler is given", /^/, "Time.test.ts and the Services table"],
  ["When code is not supported", /^/, "Verify.test.ts"],
  ["The rest of Effect", /^/, "the Rest table"],
  ["Library functions", /^The names the snippets use$/, "the names, not calls"],
  ["Decimals", /^$/, "an invariant: Bank.prove.test.ts"],
  ["Strings", /^$/, "handlers by name: the Cut table"],
];
const elsewhere = (block: Block): boolean =>
  ELSEWHERE.some(([heading, title]) => block.heading === heading && title.test(block.title));

const library = blocks.filter(
  (block) => block.heading === "Library functions" && !elsewhere(block),
);
const run = blocks.filter((block) => block.heading !== "Library functions" && !elsewhere(block));

it("every block of the page is one this test holds, or one another test does", () => {
  const unknown = run.filter((block) => !sections[block.heading]);
  expect(unknown.map((block) => `${block.heading} / ${block.title}`)).toEqual([]);
});

it("every line under Library functions is a line of a conformance table, or a part of one", async () => {
  const read = await tabled(groups, (group) => [...group.both, ...(group.known ?? [])], PRELUDE);
  const missing: Array<string> = [];
  for (const block of library)
    for (const line of await linesOf(block))
      if (!read.has(line.text)) missing.push(`${block.title}: ${line.source}`);
  expect(missing).toEqual([]);
});

it("every line the page says to write in place of unsupported code is one it shows as supported", async () => {
  const fixes = blocks.find((block) => block.title === "What the report says, and what to write");
  expect(fixes).toBeDefined();
  if (!fixes) return;
  const shown = new Set<string>();
  for (const block of [...library, ...run])
    if (!block.title.startsWith("Not supported") && block.heading !== "Not supported")
      for (const line of await linesOf(block)) shown.add(line.text);
  const lines = await linesOf(fixes);
  expect(lines.length).toBeGreaterThan(8);
  expect(lines.filter((line) => !shown.has(line.text)).map((line) => line.source)).toEqual([]);
});

it("every function the prover has a model for is on the page", () => {
  // A function the page says is not supported is on the page too.
  const text = blocks.map((block) => block.code).join("\n");
  const escaped = (name: string): string => name.replace(/[$.]/g, "\\$&");
  const missing = surface().library.filter((key) => {
    const [module = "", path = ""] = key.split(":");
    const last = path.split(".").at(-1) ?? "";
    const name =
      module === "effect/BigInt"
        ? "BigInts"
        : module === "effect/Function" || module === "effect/pipe" || module === "global"
          ? undefined
          : module.replace(/^effect\//, "");
    // A name of the language that is called itself: `String(a)`.
    if (name !== undefined && path === "")
      return !new RegExp(`(?<![\\w.])${escaped(name)}\\(`).test(text);
    if (module === "effect/Optic" && ["replace", "modify", "get", "getResult"].includes(path))
      return !new RegExp(`\\.${escaped(path)}\\(`).test(text);
    return name === undefined
      ? !new RegExp(`(?<![\\w.])${escaped(last || "pipe")}(?![\\w])`).test(text)
      : !new RegExp(`(?<![\\w.])${escaped(name)}\\.${escaped(path)}(?![\\w])`).test(text);
  });
  expect(missing).toEqual([]);
});

const unreadForms = new Set(surface().syntax.unread);
const made: Array<Group> = [];
const byForm: Array<string> = [];
for (const block of run) {
  const section = sections[block.heading];
  if (!section) continue;
  const name = `Page${block.heading.replace(/\W/g, "")}${block.title.replace(/\W/g, "")}${block.line}`;
  if (block.title.startsWith("Not supported") || block.heading === "Not supported") {
    const declarations = blocks.find(
      (each) => each.heading === block.heading && each.title === "Supported",
    );
    const { group, byForm: forms_ } = await unsupported(
      name,
      { ...block, code: block.code.replace(/^import .*$/gm, "") },
      block.heading === "Not supported"
        ? { ...section, yields: block.title !== "Schemas as code" }
        : section,
      block.heading === "Statements" ? declarations : undefined,
      unreadForms,
      forms,
    );
    byForm.push(...forms_);
    if (group.unread && group.unread.length > 0) made.push(group);
  } else made.push(await supported(name, block, section));
}

it("the page has blocks to run", () => {
  expect(made.length).toBeGreaterThan(15);
  expect(byForm.length).toBeGreaterThan(5);
});

const only = process.env.PAGE_ONLY;
check(only ? made.filter((group) => group.name.includes(only)) : made);
