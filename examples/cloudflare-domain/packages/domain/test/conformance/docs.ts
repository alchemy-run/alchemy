import * as fs from "node:fs";
import { parse } from "@alchemy.run/domain/Prove/Surface";
import type { Group } from "./cases.ts";

// The page "What can be verified" lists what is supported as code. Each line of
// it is a line of a conformance table, or a part of one: this reads the page
// and the tables as trees, and gives the lines of the page no table has.

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [field: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && "type" in value;

/** What is written around a value and says nothing of it. */
const WRAPS = new Set([
  ...["ParenthesizedExpression", "TSAsExpression", "TSSatisfiesExpression"],
  ...["TSNonNullExpression", "TSInstantiationExpression"],
]);
const SKIPPED = new Set([
  ...["start", "end", "range", "loc", "typeAnnotation", "returnType", "typeParameters"],
  ...["typeArguments", "raw", "decorators", "declare", "definite", "accessibility"],
]);

/** A tree as text: the same for two sources that differ in spacing, brackets and types. */
export const canon = (node: unknown): string => {
  if (Array.isArray(node)) return `[${node.map(canon).join(",")}]`;
  if (!isNode(node))
    return typeof node === "bigint" ? `${node}n` : (JSON.stringify(node) ?? "undefined");
  if (WRAPS.has(node.type)) return canon(node.expression);
  if (node.type === "Literal")
    return `Literal(${node.regex ? JSON.stringify(node.regex) : typeof node.value === "bigint" ? `${node.value}n` : JSON.stringify(node.value)})`;
  const fields = Object.entries(node)
    .filter(
      ([key, value]) =>
        key !== "type" &&
        !SKIPPED.has(key) &&
        value !== null &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0),
    )
    .map(([key, value]) => `${key}:${canon(value)}`);
  return `${node.type}{${fields.join(",")}}`;
};

const each = (node: unknown, visit: (node: Node) => void): void => {
  if (Array.isArray(node)) node.forEach((child) => each(child, visit));
  else if (isNode(node)) {
    visit(node);
    for (const [key, value] of Object.entries(node)) if (!SKIPPED.has(key)) each(value, visit);
  }
};

const OPEN = "(async function* () {\n";
const CLOSE = "\n});";
const body = async (source: string): Promise<ReadonlyArray<Node>> => {
  const program = (await parse(`${OPEN}${source}${CLOSE}`)) as Node;
  const statement = (program.body as ReadonlyArray<Node>)[0]!;
  let fn = statement.expression as Node;
  while (WRAPS.has(fn.type)) fn = fn.expression as Node;
  return (fn.body as Node).body as ReadonlyArray<Node>;
};

/** Every part of every expression of the tables, as text. */
export const tabled = async (
  groups: ReadonlyArray<Group>,
  pick: (group: Group) => ReadonlyArray<string>,
): Promise<ReadonlySet<string>> => {
  const parts = new Set<string>();
  for (const group of groups)
    for (const source of [
      ...(group.prelude ?? []).filter((line) => !line.startsWith("import ")),
      ...pick(group).map((expression) => `(${expression}\n);`),
    ])
      each(await body(source.replace(/^export /, "")), (node) => parts.add(canon(node)));
  return parts;
};

export interface Block {
  readonly heading: string;
  readonly title: string;
  readonly line: number;
  readonly code: string;
}

/** The code blocks of a page, each with the heading it is under. */
export const blocksOf = (file: string): ReadonlyArray<Block> => {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const blocks: Array<Block> = [];
  let heading = "";
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    if (line.startsWith("## ")) heading = line.slice(3);
    const fence = line.match(/^```typescript(?: title="(.*)")?$/);
    if (!fence) continue;
    const from = at + 1;
    while (lines[at + 1] !== "```") at++;
    blocks.push({
      heading,
      title: fence[1] ?? "",
      line: from + 1,
      code: lines.slice(from, at + 1).join("\n"),
    });
  }
  return blocks;
};

/** The lines of a block, each as the text of what it computes, with its source. */
export const linesOf = async (
  block: Block,
): Promise<ReadonlyArray<{ readonly source: string; readonly text: string }>> => {
  const code = block.code
    .split("\n")
    .map((line) => (line.startsWith("import ") ? "" : line))
    .join("\n");
  const statements = await body(code);
  const cut = (node: Node) => code.slice(node.start - OPEN.length, node.end - OPEN.length);
  return statements.flatMap((statement) => {
    // A declaration is what it is given: its name is the page's own.
    if (statement.type === "VariableDeclaration")
      return (statement.declarations as ReadonlyArray<Node>).flatMap((declared) =>
        isNode(declared.init) ? [{ source: cut(statement), text: canon(declared.init) }] : [],
      );
    if (statement.type === "ExpressionStatement")
      return [{ source: cut(statement), text: canon(statement.expression) }];
    return [{ source: cut(statement), text: canon(statement) }];
  });
};
