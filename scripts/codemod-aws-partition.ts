/**
 * Rewrite ARNs in `packages/aws/src` that hard-code the `aws` partition.
 *
 * - A value template whose region segment interpolates an identifier or
 *   property path, `arn:aws:logs:${region}:…`, becomes
 *   `arn:${partitionOf(region)}:logs:${region}:…`.
 * - A template literal type, `arn:aws:logs:${RegionID}:…`, becomes
 *   `arn:${Partition}:logs:${RegionID}:…`.
 *
 * Every other `arn:aws:` in code (a region-less or wildcard ARN, a plain
 * string, a computed region) is listed for a hand edit, since its partition
 * has to come from the surrounding environment. Rerunning the codemod on its
 * own output changes nothing.
 *
 *   bun scripts/codemod-aws-partition.ts [--check]
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ts from "tsrs/unstable/ast";
import type { Node, SourceFile } from "tsrs/unstable/ast";
import { createSyntaxProject } from "./typescript-source.ts";

const ARN = /arn:aws:([a-z0-9-]+):$/;
const SIMPLE_EXPRESSION = /^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*$/;

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Scan {
  readonly edits: Edit[];
  readonly manual: number[];
  needsValue: boolean;
  needsType: boolean;
}

/** Offsets of each literal chunk of a template, paired with the expression after it. */
const chunks = (node: Node, sourceFile: SourceFile) => {
  const template = node as unknown as {
    head: Node;
    templateSpans: readonly { type?: Node; expression?: Node; literal: Node }[];
  };
  const out: { start: number; end: number; next: Node | undefined }[] = [];
  const literals = [template.head, ...template.templateSpans.map((span) => span.literal)];
  literals.forEach((literal, index) => {
    const span = template.templateSpans[index];
    out.push({
      start: literal.getStart(sourceFile),
      end: literal.end,
      next: span ? (span.expression ?? span.type) : undefined,
    });
  });
  return out;
};

const scan = (sourceFile: SourceFile): Scan => {
  const text = sourceFile.text;
  const result: Scan = { edits: [], manual: [], needsValue: false, needsType: false };
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;

  const visit = (node: Node): void => {
    if (ts.isTemplateLiteralTypeNode(node)) {
      for (const { start, end } of chunks(node, sourceFile)) {
        const chunk = text.slice(start, end);
        for (const match of chunk.matchAll(/arn:aws:/g)) {
          const at = start + match.index;
          result.edits.push({ start: at, end: at + "arn:aws:".length, text: "arn:${Partition}:" });
          result.needsType = true;
        }
      }
    } else if (ts.isTemplateExpression(node)) {
      for (const { start, end, next } of chunks(node, sourceFile)) {
        const chunk = text.slice(start, end);
        for (const match of chunk.matchAll(/arn:aws:/g)) {
          const at = start + match.index;
          // The chunk ends with `arn:aws:<svc>:${` when the region interpolates.
          const rest = chunk.slice(match.index).replace(/\$\{$/, "");
          const region = next?.getText(sourceFile);
          if (ARN.test(rest) && region !== undefined && SIMPLE_EXPRESSION.test(region)) {
            result.edits.push({
              start: at,
              end: at + "arn:aws:".length,
              text: `arn:\${partitionOf(${region})}:`,
            });
            result.needsValue = true;
          } else {
            result.manual.push(lineOf(at));
          }
        }
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.getText(sourceFile).includes("arn:aws:")) {
        result.manual.push(lineOf(node.getStart(sourceFile)));
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return result;
};

/**
 * Add `names` to the file's import from `specifier` (`type X` for a type-only
 * name), creating the import after the last one.
 */
const addImport = (sourceFile: SourceFile, text: string, specifier: string, names: string[]) => {
  const existing = new RegExp(
    `import \\{([^}]*)\\} from "${specifier.replaceAll(".", "\\.")}";`,
  ).exec(text);
  const current = existing
    ? existing[1]!
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];
  const merged = [...new Set([...current, ...names])].sort((a, b) =>
    a.replace(/^type /, "").localeCompare(b.replace(/^type /, "")),
  );
  const line = `import { ${merged.join(", ")} } from "${specifier}";`;
  if (existing) return text.replace(existing[0], line);
  const last = sourceFile.statements
    .filter((statement) => ts.isImportDeclaration(statement))
    .at(-1);
  if (!last) return `${line}\n${text}`;
  return `${text.slice(0, last.end)}\n${line}${text.slice(last.end)}`;
};

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const check = process.argv.includes("--check");
  const root = path.resolve(import.meta.dirname, "../packages/aws/src");
  const partitionModule = path.join(root, "Partition.ts");
  const files = (yield* fs.readDirectory(root, { recursive: true }))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => path.join(root, file))
    .filter((file) => file !== partitionModule);

  const { getSourceFile } = yield* createSyntaxProject(files);
  let rewritten = 0;
  const manual: string[] = [];
  for (const file of files) {
    const sourceFile = yield* getSourceFile(file);
    const { edits, manual: lines, needsValue, needsType } = scan(sourceFile);
    for (const line of lines) {
      const source = sourceFile.text.split("\n")[line - 1]!.trim();
      manual.push(`${path.relative(process.cwd(), file)}:${line}: ${source}`);
    }
    if (edits.length === 0) continue;
    rewritten++;
    if (check) continue;
    let text = sourceFile.text;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    let specifier = path.relative(path.dirname(file), partitionModule);
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    text = addImport(sourceFile, text, specifier, [
      ...(needsValue ? ["partitionOf"] : []),
      ...(needsType ? ["type Partition"] : []),
    ]);
    yield* fs.writeFileString(file, text);
  }
  yield* Console.log(`${check ? "would rewrite" : "rewrote"} ${rewritten} files`);
  yield* Console.log(`${manual.length} ARNs need the partition from their environment:`);
  for (const line of manual) yield* Console.log(`  ${line}`);
  if (check && rewritten > 0) process.exitCode = 1;
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
