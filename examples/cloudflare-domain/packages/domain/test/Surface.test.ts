import { kinds, surface } from "@alchemy.run/domain/Prove/Surface";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { groups } from "./conformance/cases.ts";
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
    : module === "effect/Function" || module === "effect/pipe"
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

// The operators the prover reads. Any other is in a table's list of what is not read.
const OPERATORS = [
  ...["+", "-", "*", "/", "%", "<", "<=", ">", ">=", "===", "!==", "==", "!=", "in"].map(
    (operator) => `BinaryExpression ${operator}`,
  ),
  ...["&&", "||", "??"].map((operator) => `LogicalExpression ${operator}`),
  ...["!", "-", "+", "void", "typeof"].map((operator) => `UnaryExpression ${operator}`),
  ...["=", "+=", "-=", "*=", "/=", "%=", "??=", "||=", "&&="].map(
    (operator) => `AssignmentExpression ${operator}`,
  ),
  ...["++", "--"].map((operator) => `UpdateExpression ${operator}`),
  ...["const", "let", "var"].map((kind) => `VariableDeclaration ${kind}`),
];

// The rest of the language: each is in a table's list of what the prover does not read,
// with the report it has to give. None is passed over, or read as something else.
const UNREAD = [
  ...["**", "&", "|", "^", "<<", ">>", ">>>", "instanceof"].map(
    (operator) => `BinaryExpression ${operator}`,
  ),
  ...["~", "delete"].map((operator) => `UnaryExpression ${operator}`),
  ...["**=", "<<=", ">>=", ">>>=", "&=", "|=", "^="].map(
    (operator) => `AssignmentExpression ${operator}`,
  ),
  ...["TryStatement", "ThrowStatement", "LabeledStatement", "DebuggerStatement"],
  ...["ClassExpression", "TaggedTemplateExpression", "SequenceExpression", "AwaitExpression"],
  ...["ThisExpression", "MetaProperty", "ImportExpression", "TSEnumDeclaration"],
];

it.effect(
  "every kind of syntax the interpreter handles, and every operator, is in a conformance table",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const here = yield* path.fromFileUrl(new URL("./", import.meta.url));
      const interpreter = yield* fs.readFileString(
        path.join(here, "../../../../../packages/domain/src/Prove/internal/Interpreter.ts"),
      );
      // The kinds of node the interpreter has a case for: what it evaluates, runs and binds.
      const handled = [
        ...new Set(
          [
            ...interpreter.matchAll(
              /case "([A-Z]\w*(?:Expression|Statement|Declaration|Pattern|Literal|Element)|Identifier)"/g,
            ),
          ].map((match) => match[1]!),
        ),
      ].sort();
      expect(handled.length).toBeGreaterThan(40);
      const found = new Set<string>();
      for (const source of sources)
        for (const kind of yield* Effect.promise(() => kinds(source))) found.add(kind);
      expect(handled.filter((kind) => !found.has(kind))).toEqual([]);
      expect(OPERATORS.filter((operator) => !found.has(operator))).toEqual([]);
      expect(UNREAD.filter((kind) => !found.has(kind))).toEqual([]);
      // Nothing is on both lists: what is read is not also what is reported.
      expect(UNREAD.filter((kind) => handled.includes(kind) || OPERATORS.includes(kind))).toEqual(
        [],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
