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
  shared: ReadonlyArray<string> = [],
): Promise<ReadonlySet<string>> => {
  const parts = new Set<string>();
  for (const group of groups)
    for (const source of [
      ...[...shared, ...(group.prelude ?? [])].filter((line) =>
        /^(export )?(const|class) /.test(line),
      ),
      // The names a table's expressions use, where it makes them from its inputs.
      group.bind(true),
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

// --- A block of the page as a table of its own: its lines are run, not looked up.

/** What the lines of a section are written over, and how they are run. */
export interface Section {
  readonly base: Pick<Group, "input" | "pins" | "differs" | "bind">;
  /** Statements before any line: the names the section's lines use. */
  readonly context?: string;
  readonly prelude?: ReadonlyArray<string>;
  /** The lines are the body of `Effect.gen`. */
  readonly effectful?: boolean;
  /** Each line that is an expression is an effect, which is yielded. */
  readonly yields?: boolean;
  /** How a line that is not supported is run, where it is not an effect to yield: a stream is collected. */
  readonly runs?: (line: string) => string;
  /** Lines whose value is not kept: one that holds a function is not a value an event carries. */
  readonly quiet?: RegExp;
  /** How many lines one command computes. */
  readonly chunk?: number;
}

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const TYPES = new Set(["TSTypeAliasDeclaration", "TSInterfaceDeclaration"]);

const namesOf = (pattern: unknown, out: Array<string> = []): Array<string> => {
  if (!isNode(pattern)) return out;
  if (pattern.type === "Identifier") out.push(pattern.name as string);
  else if (pattern.type === "ObjectPattern")
    for (const property of pattern.properties as ReadonlyArray<Node>)
      namesOf(property.type === "RestElement" ? property.argument : property.value, out);
  else if (pattern.type === "ArrayPattern")
    for (const element of pattern.elements as ReadonlyArray<unknown>) namesOf(element, out);
  else if (pattern.type === "AssignmentPattern") namesOf(pattern.left, out);
  else if (pattern.type === "RestElement") namesOf(pattern.argument, out);
  return out;
};

const unwrapped = (node: Node): Node => {
  let at = node;
  while (WRAPS.has(at.type)) at = at.expression as Node;
  return at;
};

const holdsFunction = (node: unknown): boolean => {
  let found = false;
  each(node, (part) => {
    if (FUNCTIONS.has(part.type) || part.type === "ClassExpression") found = true;
  });
  return found;
};

interface Line {
  readonly node: Node;
  readonly source: string;
}

const statementsOf = async (block: Block): Promise<ReadonlyArray<Line>> => {
  const statements = await body(block.code);
  return statements.map((node) => ({
    node,
    source: block.code.slice(node.start - OPEN.length, node.end - OPEN.length),
  }));
};

const closed = (source: string): string => (/[;}]\s*$/.test(source) ? source : `${source};`);

/** A line as it is run: its value kept where it is one an event can carry. */
const kept = (line: Line, section: Section): string => {
  const { node, source } = line;
  if (section.quiet?.test(source)) return closed(source);
  if (node.type === "ExpressionStatement") {
    const expression = unwrapped(node.expression as Node);
    const text = source.replace(/;\s*$/, "");
    // A function written out is called, so that its body is read.
    if (FUNCTIONS.has(expression.type)) return `out_.push((${text})(a));`;
    if (holdsFunction(expression) && expression.type !== "CallExpression") return `(${text});`;
    return section.yields ? `out_.push(yield* (${text}));` : `out_.push(${text});`;
  }
  if (node.type === "VariableDeclaration") {
    const declarations = node.declarations as ReadonlyArray<Node>;
    const names = declarations.flatMap((declared) =>
      isNode(declared.init) && !holdsFunction(declared.init) ? namesOf(declared.id) : [],
    );
    return `${closed(source)}${names.length > 0 ? ` out_.push(${names.join(", ")});` : ""}`;
  }
  return closed(source);
};

const wrap = (section: Section, statements: string): string =>
  section.effectful || section.yields
    ? `Effect.gen(function* () { ${statements} })`
    : `(() => { ${statements} })()`;

const declared = (lines: ReadonlyArray<Line>, type: string): string =>
  lines
    .filter((line) => line.node.type === type)
    .map((line) => closed(line.source))
    .join(" ");

/** A "Supported" block: its lines, a few to a command, each compared with the real code. */
export const supported = async (name: string, block: Block, section: Section): Promise<Group> => {
  const lines = (await statementsOf(block)).filter((line) => !TYPES.has(line.node.type));
  // A function is declared for the whole block, wherever it is written.
  const functions = declared(lines, "FunctionDeclaration");
  const rest = lines.filter((line) => line.node.type !== "FunctionDeclaration");
  const size = section.chunk ?? 6;
  const both: Array<string> = [];
  for (let at = 0; at < rest.length; at += size) {
    const before = declared(rest.slice(0, at), "VariableDeclaration");
    const mine = rest
      .slice(at, at + size)
      .map((line) => kept(line, section))
      .join(" ");
    both.push(
      wrap(
        section,
        `${section.context ?? ""} ${functions} ${before} const out_ = []; ${mine} return out_;`,
      ),
    );
  }
  return {
    ...section.base,
    name,
    chunk: 1,
    effectful: section.effectful || section.yields,
    prelude: section.prelude,
    both,
  };
};

/**
 * A "Not supported" block: each line is reported. A line written with a form
 * of the language the prover lists as one it does not read is reported for
 * that, which `Surface.test.ts` holds; every other line is run alone.
 */
export const unsupported = async (
  name: string,
  block: Block,
  section: Section,
  declarations: Block | undefined,
  unreadForms: ReadonlySet<string>,
  formsOf: (source: string) => Promise<ReadonlySet<string>>,
): Promise<{ readonly group: Group; readonly byForm: ReadonlyArray<string> }> => {
  const given = declarations
    ? (await statementsOf(declarations)).filter((line) => !TYPES.has(line.node.type))
    : [];
  const before = `${section.context ?? ""} ${declared(given, "FunctionDeclaration")} ${declared(given, "VariableDeclaration")}`;
  const unread: Array<readonly [string, RegExp]> = [];
  const byForm: Array<string> = [];
  // The forms of what a line is written inside are not the line's.
  const around = await formsOf(`(async function* () { 0; });`);
  for (const line of await statementsOf(block)) {
    const written = await formsOf(`(async function* () { ${closed(line.source)} });`);
    if ([...written].some((form) => !around.has(form) && unreadForms.has(form))) {
      byForm.push(line.source);
      continue;
    }
    const text = line.source.replace(/;\s*$/, "");
    const run =
      line.node.type === "ExpressionStatement"
        ? section.runs
          ? `out_.push(${section.runs(text)});`
          : section.yields
            ? `out_.push(yield* (${text}));`
            : `out_.push(${text});`
        : closed(line.source);
    unread.push([wrap(section, `${before} const out_ = []; ${run} return out_;`), /./]);
  }
  return {
    byForm,
    group: {
      ...section.base,
      name,
      effectful: section.effectful || section.yields,
      prelude: section.prelude,
      both: [],
      unread,
    },
  };
};
