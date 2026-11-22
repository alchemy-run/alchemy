import * as Data from "effect/Data";
import type * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

/** How a program calls a tool: `await tools.add(args)`, or `yield* tools.add(args)`. */
export type DeclarationForm = "async" | "effect";

/** One call a program can make. */
export interface DeclaredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Schema.Top;
  readonly success: Schema.Top;
  /** A `Schema.TaggedError` class, or a union of several. */
  readonly failure?: Schema.Top;
}

/**
 * Tools that share a namespace, with the namespaces inside it: an MCP
 * server's tools, a Domain Api's commands and reads.
 */
export interface DeclaredNamespace {
  readonly name: string;
  readonly description?: string;
  readonly tools?: ReadonlyArray<DeclaredTool>;
  readonly namespaces?: ReadonlyArray<DeclaredNamespace>;
}

/** Two different schemas in one namespace share a name, so one declaration cannot stand for both. */
export class DuplicateDeclaration extends Data.TaggedError("DuplicateDeclaration")<{
  readonly namespace: string;
  readonly name: string;
  readonly message: string;
}> {}

/** A name as a JavaScript identifier: every other character becomes `_`. */
export const toIdentifier = (name: string): string => {
  const identifier = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(identifier) ? `_${identifier}` : identifier;
};

/** What a named schema is declared as. */
type Kind = "interface" | "error";

interface Named {
  readonly name: string;
  readonly kind: Kind;
  readonly ast: SchemaAST.AST;
  readonly description: string | undefined;
}

/**
 * The node a value has on the wire: a script reads a tool's result, and a
 * failure's fields, as the JSON its schema encodes to.
 */
const encoded = (ast: SchemaAST.AST): SchemaAST.AST => {
  const link = ast.encoding?.at(-1);
  return link === undefined ? ast : encoded(link.to);
};

const comment = (text: string | undefined, indent: string, extra: ReadonlyArray<string> = []) => {
  const lines = [...(text?.trim().split("\n") ?? []), ...extra];
  if (lines.length === 0) return [];
  if (lines.length === 1) return [`${indent}/** ${lines[0]} */`];
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`];
};

const key = (name: PropertyKey): string =>
  typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? name
    : JSON.stringify(String(name));

/** Renders one namespace's types, collecting the named schemas it meets. */
const makeScope = (namespace: string) => {
  const named = new Map<string, Named>();

  const reference = (ast: SchemaAST.AST, kind: Kind): string | undefined => {
    const name = SchemaAST.resolveIdentifier(ast);
    if (name === undefined) return undefined;
    const identifier = toIdentifier(name);
    const existing = named.get(identifier);
    if (existing === undefined) {
      named.set(identifier, {
        name: identifier,
        kind,
        ast,
        description: SchemaAST.resolveDescription(ast),
      });
    } else if (existing.ast !== ast && body(existing.ast, "") !== body(ast, "")) {
      throw new DuplicateDeclaration({
        namespace,
        name: identifier,
        message: `Two different schemas in \`${namespace}\` are named \`${identifier}\`. Rename one, or move it to its own namespace.`,
      });
    } else if (kind === "error" && existing.kind !== "error") {
      named.set(identifier, { ...existing, kind });
    }
    return identifier;
  };

  /** A type, by name when its schema has one. */
  const type = (ast: SchemaAST.AST, indent: string): string =>
    reference(ast, "interface") ?? body(ast, indent);

  /** A type written out, whether or not its schema has a name. */
  const body = (source: SchemaAST.AST, indent: string, compact = true): string => {
    const ast = encoded(source);
    switch (ast._tag) {
      case "String":
        return "string";
      case "Number":
        return "number";
      case "Boolean":
        return "boolean";
      case "BigInt":
        return "bigint";
      case "Null":
        return "null";
      case "Undefined":
        return "undefined";
      case "Void":
        return "void";
      case "Never":
        return "never";
      case "Any":
      case "Unknown":
        return "unknown";
      case "ObjectKeyword":
        return "object";
      case "Literal":
        return typeof ast.literal === "bigint" ? `${ast.literal}n` : JSON.stringify(ast.literal);
      case "Enum":
        return ast.enums.map(([, value]) => JSON.stringify(value)).join(" | ");
      case "TemplateLiteral":
        return "string";
      case "Suspend":
        return type(ast.thunk(), indent);
      case "Union": {
        const members = [...new Set(ast.types.map((member) => type(member, indent)))];
        return members.length === 0 ? "never" : members.join(" | ");
      }
      case "Arrays": {
        const wrap = (text: string) => (/[ |]/.test(text) ? `(${text})` : text);
        const rest = ast.rest[0];
        if (ast.elements.length === 0 && rest !== undefined) {
          return `ReadonlyArray<${type(rest, indent)}>`;
        }
        const elements = ast.elements.map((element) => type(element, indent));
        return `readonly [${[
          ...elements,
          ...(rest === undefined ? [] : [`...${wrap(type(rest, indent))}[]`]),
        ].join(", ")}]`;
      }
      case "Objects": {
        const inner = `${indent}  `;
        const lines = [
          ...ast.propertySignatures.flatMap((property) => {
            const optional = SchemaAST.isOptional(property.type);
            const field = optional ? withoutUndefined(property.type) : property.type;
            return [
              ...comment(SchemaAST.resolveDescription(property.type), inner),
              `${inner}readonly ${key(property.name)}${optional ? "?" : ""}: ${type(field, inner)};`,
            ];
          }),
          ...ast.indexSignatures.map(
            (signature) => `${inner}readonly [key: string]: ${type(signature.type, inner)};`,
          ),
        ];
        if (lines.length === 0) return "{}";
        // An unnamed shape without comments reads best on one line, when it fits.
        const flat = `{ ${lines
          .map((line) =>
            line
              .trim()
              .replace(/^readonly /, "")
              .replace(/;$/, ""),
          )
          .join("; ")} }`;
        return compact &&
          flat.length <= 60 &&
          !lines.some((line) => /^\s*(\/\*\*|\*)/.test(line) || line.includes("\n"))
          ? flat
          : `{\n${lines.join("\n")}\n${indent}}`;
      }
      default:
        return "unknown";
    }
  };

  /** An optional field says so with `?`; its `| undefined` would repeat it. */
  const withoutUndefined = (ast: SchemaAST.AST): SchemaAST.AST => {
    if (!SchemaAST.isUnion(ast)) return ast;
    const kept = ast.types.filter((member) => !SchemaAST.isUndefined(member));
    return kept.length === 1 ? kept[0]! : ast;
  };

  /** The failures of a tool: each a class a program can match on. */
  const failures = (ast: SchemaAST.AST | undefined): ReadonlyArray<string> => {
    if (ast === undefined || SchemaAST.isNever(ast)) return [];
    if (SchemaAST.isUnion(ast) && SchemaAST.resolveIdentifier(ast) === undefined) {
      return [...new Set(ast.types.flatMap(failures))];
    }
    return [reference(ast, "error") ?? body(ast, "  ")];
  };

  return { named, type, body, failures };
};

/** The fields of an error, without the `_tag` its class already states. */
const fieldsOf = (
  ast: SchemaAST.AST,
): { readonly tag: string | undefined; readonly ast: SchemaAST.AST } => {
  const wire = encoded(ast);
  if (!SchemaAST.isObjects(wire)) return { tag: undefined, ast: wire };
  const tagged = wire.propertySignatures.find((property) => property.name === "_tag");
  const tag =
    tagged !== undefined &&
    SchemaAST.isLiteral(tagged.type) &&
    typeof tagged.type.literal === "string"
      ? tagged.type.literal
      : undefined;
  return {
    tag,
    ast: new SchemaAST.Objects(
      wire.propertySignatures.filter((property) => property.name !== "_tag"),
      wire.indexSignatures,
    ),
  };
};

const renderNamespace = (
  form: DeclarationForm,
  namespace: DeclaredNamespace,
  path: string,
  indent: string,
): ReadonlyArray<string> => {
  const scope = makeScope(path);
  const inner = `${indent}  `;

  const functions = (namespace.tools ?? []).map((tool) => {
    const args = scope.type(tool.parameters.ast, inner);
    const parameters = args === "{}" ? "" : `args: ${args}`;
    const success = scope.type(tool.success.ast, inner);
    const failed = scope.failures(tool.failure?.ast);
    const signature = `${inner}function ${toIdentifier(tool.name)}(${parameters})`;
    if (form === "effect") {
      return [
        ...comment(tool.description, inner),
        `${signature}: Effect<${[success, ...(failed.length === 0 ? [] : [failed.join(" | ")])].join(", ")}>;`,
      ];
    }
    return [
      ...comment(
        tool.description,
        inner,
        failed.map((failure) => `@throws {${failure}}`),
      ),
      `${signature}: Promise<${success}>;`,
    ];
  });

  // Declaring a schema can meet others, so declare until none are new.
  const declared = new Map<string, ReadonlyArray<string>>();
  for (let size = -1; size !== scope.named.size;) {
    size = scope.named.size;
    for (const entry of [...scope.named.values()]) {
      declared.set(entry.name, declare(form, scope, entry, inner));
    }
  }

  const nested = (namespace.namespaces ?? []).map((child) => [
    ...comment(child.description, inner),
    `${inner}namespace ${toIdentifier(child.name)} {`,
    ...renderNamespace(form, child, `${path}.${toIdentifier(child.name)}`, inner),
    `${inner}}`,
  ]);

  return [...declared.values(), ...functions, ...nested]
    .map((block) => block.join("\n"))
    .join("\n\n")
    .split("\n");
};

const declare = (
  form: DeclarationForm,
  scope: ReturnType<typeof makeScope>,
  entry: Named,
  indent: string,
): ReadonlyArray<string> => {
  const head = comment(entry.description, indent);
  if (entry.kind === "interface") {
    const wire = encoded(entry.ast);
    return SchemaAST.isObjects(wire)
      ? [...head, `${indent}interface ${entry.name} ${scope.body(entry.ast, indent, false)}`]
      : [...head, `${indent}type ${entry.name} = ${scope.body(entry.ast, indent)};`];
  }
  const { tag, ast } = fieldsOf(entry.ast);
  const fields = scope.body(ast, indent, false);
  if (form === "effect") {
    return [
      ...head,
      `${indent}class ${entry.name} extends Data.TaggedError(${JSON.stringify(tag ?? entry.name)})<${fields}> {}`,
    ];
  }
  const members = fields === "{}" ? [] : fields.split("\n").slice(1, -1);
  return [
    ...head,
    `${indent}class ${entry.name} extends Error {`,
    `${indent}  readonly _tag: ${JSON.stringify(tag ?? entry.name)};`,
    ...members,
    `${indent}}`,
  ];
};

/**
 * The TypeScript declarations a code mode program is written against:
 * `tools`, a namespace holding each tool as a function, each named schema
 * as an interface, and each declared failure as a class. A schema's
 * `description` is its JSDoc. Types are what a value is on the wire.
 *
 * In the async form a tool returns a `Promise` and its failures are
 * `@throws` tags. In the Effect form it returns an `Effect<A, E>` with its
 * failures as `E`, and requires nothing.
 */
export const renderDeclarations = (
  form: DeclarationForm,
  tools: Omit<DeclaredNamespace, "name">,
): string =>
  [
    "declare namespace tools {",
    ...renderNamespace(form, { ...tools, name: "tools" }, "tools", ""),
    "}",
  ].join("\n");
