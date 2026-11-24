// A file and the files it reads: every way a name is imported, exported and
// declared at the top of a file. `Modules.test.ts` writes these files, has
// the prover read an aggregate that uses each name, and has the real code run
// on the same inputs.

/** The files the aggregate imports from, by name. */
export const files: Readonly<Record<string, string>> = {
  "lib.ts": [
    `import * as Data from "effect/Data";`,
    `export const one = 1;`,
    `const hidden = 2;`,
    `export const viaHidden = hidden + 1;`,
    `export function double(n: number) { return n * 2; }`,
    `export const triple = (n: number) => n * 3;`,
    `function local(n: number) { return n + 1; }`,
    `export const usesLocal = (n: number) => local(n);`,
    `const five = 5, six = 6;`,
    `export { five, six as half };`,
    `export let counter = 7;`,
    `export var legacy = 8;`,
    `export const [first, second] = [11, 12];`,
    `export const { left, right: renamed } = { left: 13, right: 14 };`,
    `export class Fault extends Data.TaggedError("Fault")<{ readonly n: number }> {}`,
    `export class Point extends Data.Class<{ readonly x: number }> {}`,
    `export type Alias = number;`,
    `export interface Shape { readonly n: number }`,
    `export enum Level { Low, High }`,
    `export namespace Space { export const inside = 21; }`,
    `export class Counter { constructor(readonly n: number) {} }`,
    `export default function byDefault(n: number) { return n - 1; }`,
  ].join("\n"),
  "value.ts": [`const value = 9;`, `export default value;`].join("\n"),
  "arrow.ts": `export default (n: number) => n + 10;`,
  "more.ts": [
    `export const four = 4;`,
    `export const plus = (n: number) => n + 4;`,
    `export * from "./deep.ts";`,
  ].join("\n"),
  "deep.ts": `export const deepest = 30;`,
  "barrel.ts": [
    `export { one as uno, double } from "./lib.ts";`,
    `export * from "./more.ts";`,
    `export * as packed from "./more.ts";`,
    `export { default as theDefault } from "./value.ts";`,
    `import { triple } from "./lib.ts";`,
    `export { triple };`,
    `export type { Alias } from "./lib.ts";`,
  ].join("\n"),
  "effects.ts": `export {};`,
  "loop-a.ts": [
    `import { fromB } from "./loop-b.ts";`,
    `export const fromA = (n: number) => n + 1;`,
    `export const round = (n: number) => fromB(n) * 2;`,
  ].join("\n"),
  "loop-b.ts": [
    `import { fromA } from "./loop-a.ts";`,
    `export const fromB = (n: number) => fromA(n) + 1;`,
  ].join("\n"),
};

/** What the aggregate's own file imports. */
export const imports: ReadonlyArray<string> = [
  `import { one, viaHidden, double, triple, usesLocal, five, half, counter, legacy } from "./lib.ts";`,
  `import { first, second, left, renamed, Fault, Point, Level, Space } from "./lib.ts";`,
  `import { one as uno2 } from "./lib.ts";`,
  `import * as Lib from "./lib.ts";`,
  `import byDefault from "./lib.ts";`,
  `import theValue from "./value.ts";`,
  `import addTen from "./arrow.ts";`,
  `import byDefaultToo, { one as alongside } from "./lib.ts";`,
  `import type { Alias, Shape } from "./lib.ts";`,
  `import { type Alias as Alias2, six2 } from "./local.ts";`,
  `import "./effects.ts";`,
  `import { uno, double as barrelDouble, four, plus, deepest, packed, theDefault, triple as barrelTriple } from "./barrel.ts";`,
  `import * as Barrel from "./barrel.ts";`,
  `import { round } from "./loop-a.ts";`,
];

/** The aggregate's own top-level lines. */
export const own: ReadonlyArray<string> = [
  `const top = 40;`,
  `const { fromObject, nested: { inner } } = { fromObject: 41, nested: { inner: 42 } };`,
  `const [fromArray] = [43];`,
  `let changing = 44;`,
  `function ownFunction(n: number) { return n + top; }`,
  `const ownArrow = (n: number) => ownFunction(n) * 2;`,
  `const later = () => declaredBelow + 1;`,
  `const declaredBelow = 45;`,
  `class Mine extends Data.TaggedError("Mine")<{ readonly n: number }> {}`,
  `class Plain { constructor(readonly n: number) {} }`,
  `class Child extends Plain { static made = 0; static { Child.made = 1; } constructor() { super(1); } twice() { return this.n * 2; } }`,
  `enum OwnLevel { Low, High }`,
  `namespace OwnSpace { export const inside = 21; }`,
];

export interface Case {
  readonly name: string;
  readonly expression: string;
  /** What the report has to say, for a name the prover is not to read. */
  readonly unread?: RegExp;
}

const read = (name: string, expression: string): Case => ({ name, expression });
const unread = (name: string, expression: string, reason: RegExp): Case => ({
  name,
  expression,
  unread: reason,
});

export const cases: ReadonlyArray<Case> = [
  read("NamedConst", `one + a`),
  read("ConstOfHidden", `viaHidden + a`),
  read("FunctionDeclared", `double(a)`),
  read("ArrowExported", `triple(a)`),
  read("FunctionUsingLocal", `usesLocal(a)`),
  read("ExportedByName", `five + a`),
  read("ExportedAsAnother", `half + a`),
  read("ExportedLet", `counter + a`),
  read("ExportedVar", `legacy + a`),
  read("ExportedArrayPattern", `first + second + a`),
  read("ExportedObjectPattern", `left + renamed + a`),
  read("ExportedErrorClass", `new Fault({ n: a }).n`),
  read("ExportedDataClass", `new Point({ x: a }).x`),
  read("ImportedAsAnother", `uno2 + a`),
  read("Namespace", `Lib.one + Lib.double(a)`),
  read("NamespaceDefault", `Lib.default(a)`),
  read("DefaultFunction", `byDefault(a)`),
  read("DefaultConst", `theValue + a`),
  read("DefaultArrow", `addTen(a)`),
  read("DefaultAndNames", `byDefaultToo(a) + alongside`),
  read("ImportedBesideAType", `six2 + a`),
  read("ReExportedAsAnother", `uno + a`),
  read("ReExported", `barrelDouble(a)`),
  read("ReExportedAfterImport", `barrelTriple(a)`),
  read("StarExport", `four + plus(a)`),
  read("StarOfAStar", `deepest + a`),
  read("StarAsNamespace", `packed.four + packed.plus(a)`),
  read("ReExportedDefault", `theDefault + a`),
  read("NamespaceOfBarrel", `Barrel.uno + Barrel.four + Barrel.packed.four + Barrel.deepest + a`),
  read("FilesThatImportEachOther", `round(a)`),
  read("OwnConst", `top + a`),
  read("OwnObjectPattern", `fromObject + inner + a`),
  read("OwnArrayPattern", `fromArray + a`),
  read("OwnLet", `changing + a`),
  read("OwnFunction", `ownFunction(a)`),
  read("OwnArrow", `ownArrow(a)`),
  read("OwnConstDeclaredBelow", `later() + a`),
  read("OwnErrorClass", `new Mine({ n: a }).n`),
  // An exported enum and namespace are the values the file's module holds.
  read("ExportedEnum", `Level.High + a`),
  read("ExportedNamespace", `Space.inside + a`),
  // An enum the file keeps to itself is read where it is declared.
  read("OwnEnum", `OwnLevel.High + a`),
  unread("OwnNamespace", `OwnSpace.inside + a`, /refers to OwnSpace, which the prover cannot find/),
  unread("OwnPlainClass", `new Plain(a).n`, /Plain is a class that its file does not export/),
  unread(
    "OwnClassWithABody",
    `new Child().twice() + a`,
    /Child is a class that its file does not export/,
  ),
  unread("ExportedPlainClass", `new Lib.Counter(a).n`, /./),
  // A name a file declares and does not export is not on its namespace.
  read("NotExported", `Lib.hidden === undefined ? a : -1`),
  read("NotExportedOfBarrel", `[Barrel.one, Barrel.hidden, Barrel.half].length + a`),
];

/** The aggregate's file: one command for each case, whose handler computes the case's expression. */
export const aggregate = (): string =>
  [
    "// @ts-nocheck",
    `import * as Domain from "@alchemy.run/domain";`,
    `import * as Data from "effect/Data";`,
    `import * as Schema from "effect/Schema";`,
    ...imports,
    ...own,
    `const Small = Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 }));`,
    `export class Done extends Domain.Event("Done", { result: Schema.Unknown }) {}`,
    ...cases.map(
      ({ name }) =>
        `export class ${name} extends Domain.Command("${name}", { input: { id: Schema.String, a: Small }, events: [Done] }) {}`,
    ),
    `export class Bench extends Domain.Aggregate("Bench", {`,
    `  id: Schema.String,`,
    `  state: Schema.Struct({ runs: Schema.Int }),`,
    `  initial: { runs: 0 },`,
    `  invariants: { NeverBelowZero: (bench) => bench.runs >= 0 },`,
    `  commands: [${cases.map(({ name }) => name).join(", ")}],`,
    `  keyOf: (command) => command.id,`,
    `  decide: {`,
    ...cases.map(
      ({ name, expression }) =>
        `    ${name}: (_bench, command) => { const a = command.a; return [new Done({ result: (${expression}) })]; },`,
    ),
    `  },`,
    `  evolve: { Done: (bench) => ({ runs: bench.runs + 1 }) },`,
    `}) {}`,
  ].join("\n");

/** Every file the test writes, by name. */
export const sources = (): Readonly<Record<string, string>> => ({
  ...files,
  "local.ts": [`export type Alias = number;`, `export const six2 = 6;`].join("\n"),
  "Bench.aggregate.ts": aggregate(),
});
