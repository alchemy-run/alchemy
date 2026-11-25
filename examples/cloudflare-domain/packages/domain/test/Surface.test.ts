import { forms, surface } from "@alchemy.run/domain/Prove/Surface";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { groups } from "./conformance/cases.ts";
import * as Modules from "./conformance/modules.ts";
import { chunksOf, sourceOf } from "./conformance/run.ts";

// What the prover reads is a list it can give: every library function it has
// a model for, every method of a string and an array, and every kind of
// syntax its interpreter handles. The conformance tables compare each with
// the real code. This checks that the tables miss none: a model, a method or
// a kind of syntax added to the prover without a line in a table fails here.

const sources = groups.map((group) => sourceOf(group, chunksOf(group)));
const text = sources.join("\n");

/** How a table writes a module: its import name, or nothing for names imported bare. */
const written = (module: string): string | undefined =>
  module === "effect/BigInt"
    ? "BigInts"
    : module === "effect/Function" || module === "effect/pipe" || module === "global"
      ? undefined
      : module.replace(/^effect\//, "");

const escaped = (name: string): string => name.replace(/[$.]/g, "\\$&");

/** Whether a table calls or reads `module:path`. */
const used = (key: string): boolean => {
  const [module = "", path = ""] = key.split(":");
  const name = written(module);
  const last = path.split(".").at(-1) ?? "";
  // An optic's and a matcher's own methods are called on the value: `.replace(`, `.modify(`.
  if (module === "effect/Optic" && ["replace", "modify", "get", "getResult"].includes(path))
    return new RegExp(`Optic\\.[^;\\n]*\\.${escaped(path)}\\(`).test(text);
  // A name of the language that is called itself: `String(a)`.
  if (name !== undefined && path === "")
    return new RegExp(`(?<![\\w.])${escaped(name)}\\(`).test(text);
  return name === undefined
    ? new RegExp(`(?<![\\w.])${escaped(last || "pipe")}(?![\\w])`).test(text)
    : new RegExp(`(?<![\\w.])${escaped(name)}\\.${escaped(path)}(?![\\w])`).test(text);
};

it("every library function the prover has a model for is in a conformance table", () => {
  const { library } = surface();
  expect(library.length).toBeGreaterThan(900);
  expect(library.filter((key) => !used(key))).toEqual([]);
});

it("every method of a string and of an array the prover reads is in a conformance table", () => {
  const { strings, arrays } = surface();
  const missing = [...new Set([...strings, ...arrays])].filter(
    (name) => !new RegExp(`\\.${escaped(name)}(?![\\w])`).test(text),
  );
  expect(missing).toEqual([]);
});

it("every module whose functions are run as they are is called in a conformance table", () => {
  const { computed } = surface();
  // These are the real functions, run on values the code writes: one call of each module
  // shows the prover hands them their arguments and takes their results.
  const missing = computed.filter((module) => {
    const name = written(module);
    return name !== undefined && !new RegExp(`(?<![\\w.])${escaped(name)}\\.\\w`).test(text);
  });
  expect(missing).toEqual([]);
});

// The language is a list too: every form of it, read or not. Each form the prover reads is
// written in a table that is compared with the real code, and each form it does not read is
// written where a table says what the report has to give.

/** An expression of a table, as a file that parses. */
const wrapped = (expression: string): string => `(async function* () { (${expression}); });`;

it.effect("every form of the language is in a table: read and compared, or reported", () =>
  Effect.gen(function* () {
    const { syntax } = surface();
    const formsOf = (source: string) => Effect.promise(() => forms(source));
    const read = new Set<string>();
    const stopped = new Set<string>();
    for (const group of groups) {
      for (const expression of [...group.both, ...(group.known ?? [])])
        for (const form of yield* formsOf(wrapped(expression))) read.add(form);
      for (const [expression] of group.unread ?? [])
        for (const form of yield* formsOf(wrapped(expression))) stopped.add(form);
    }
    // The files of the module table: what is imported, exported and declared at the top of a file.
    const files = new Set<string>();
    for (const source of Object.values(Modules.sources()))
      for (const form of yield* formsOf(source.replace("// @ts-nocheck", ""))) files.add(form);
    const written = new Set([...read, ...stopped, ...files]);
    // Nothing a table is written with is missing from the list.
    expect([...written].filter((form) => form.startsWith("undeclared"))).toEqual([]);
    // What `wrapped` adds is not what a table tests.
    const wrapper = new Set(yield* formsOf(wrapped("0")));
    const tested = (forms: ReadonlySet<string>) => (form: string) =>
      forms.has(form) && !(wrapper.has(form) && !form.startsWith("Literal"));
    expect(syntax.read.filter((form) => !read.has(form) && !files.has(form))).toEqual([]);
    expect(syntax.unread.filter((form) => !stopped.has(form) && !files.has(form))).toEqual([]);
    // No form the prover does not read is in what a table compares with the real code.
    expect(syntax.unread.filter(tested(read))).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("every kind of node the interpreter and the loader name is a form on the list", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const here = yield* path.fromFileUrl(new URL("./", import.meta.url));
    const internal = path.join(here, "../../../../../packages/domain/src/Prove/internal");
    const { syntax } = surface();
    const listed = [...syntax.read, ...syntax.unread];
    const named = new Set<string>();
    for (const file of ["Interpreter.ts", "Source.ts"]) {
      const source = yield* fs.readFileString(path.join(internal, file));
      for (const match of source.matchAll(
        /(?:case |type (?:===|!==) )"([A-Z]\w*(?:Expression|Statement|Declaration|Declarator|Pattern|Literal|Element|Specifier|Property|Case)|Identifier|Property)"/g,
      ))
        named.add(match[1]!);
    }
    expect(named.size).toBeGreaterThan(45);
    expect(
      [...named].filter(
        (kind) =>
          !listed.some(
            (form) => form === kind || form.startsWith(`${kind}:`) || form.startsWith(`${kind} `),
          ),
      ),
    ).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Every function of a module the prover reads is one it has a model for,
// one it reports with a reason, or one it reads another way. A function the
// library adds is on none of these lists until the prover is taught it or
// says why it does not run it. Schemas are built, never run: a schema's
// functions are read where the schema is used.
it("every function of a module the prover reads is modelled, or reported with a reason", async () => {
  const { library, computed, judged, elsewhere } = surface();
  const known = new Set([...library, ...Object.keys(judged), ...Object.keys(elsewhere)]);
  const pure = new Set(computed);
  const modules = [
    ...new Set(library.map((key) => key.split(":")[0]!).filter((m) => m.startsWith("effect/"))),
    // `effect/pipe` is the prover's name for `.pipe`, which no module exports.
  ].filter((module) => !pure.has(module) && module !== "effect/Schema" && module !== "effect/pipe");
  const missing: Array<string> = [];
  for (const module of modules.sort()) {
    const real = (await import(/* @vite-ignore */ module)) as Record<string, unknown>;
    for (const name of Object.keys(real))
      if (!/TypeId$/.test(name) && !known.has(`${module}:${name}`))
        missing.push(`${module}:${name}`);
  }
  expect(missing).toEqual([]);
  // A function is either run or reported, never both.
  expect(library.filter((key) => key in judged)).toEqual([]);
});
