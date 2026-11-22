import * as Data from "effect/Data";
import type * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

/** How a program calls a tool: `await tools.add(args)`, or `yield* tools.add(args)`. */
export type DeclarationForm = "async" | "effect";

/** A JSON Schema, as an MCP server or a harness's own tool describes itself. */
export type JsonSchema = { readonly [key: string]: unknown } | boolean;

const isSchema = (u: Schema.Top | JsonSchema | undefined): u is Schema.Top =>
  (typeof u === "object" || typeof u === "function") &&
  u !== null &&
  "ast" in u &&
  SchemaAST.isAST(u.ast);

/** One call a program can make. */
export interface DeclaredTool {
  readonly name: string;
  /** The tool's name where scripts run, when it differs (`mcp__github__get_issue`). */
  readonly callAs?: string;
  readonly description: string;
  readonly parameters: Schema.Top | JsonSchema;
  /** What a call returns. Without one, its text. */
  readonly success?: Schema.Top | JsonSchema;
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
  /** The name both schemas have. */
  readonly declaration: string;
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

/** An object type from its member lines: on one line when it is unnamed, short and has no comments. */
const shape = (lines: ReadonlyArray<string>, indent: string, compact: boolean): string => {
  if (lines.length === 0) return "{}";
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
};

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
        declaration: identifier,
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
        return shape(lines, indent, compact);
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

  /** A JSON Schema as a type. It has no names to declare. */
  const json = (schema: JsonSchema | undefined, indent: string): string => {
    if (schema === undefined || schema === true) return "unknown";
    if (schema === false) return "never";
    const node = schema as {
      readonly type?: string | ReadonlyArray<string>;
      readonly enum?: ReadonlyArray<unknown>;
      readonly const?: unknown;
      readonly anyOf?: ReadonlyArray<JsonSchema>;
      readonly oneOf?: ReadonlyArray<JsonSchema>;
      readonly items?: JsonSchema;
      readonly properties?: Readonly<Record<string, JsonSchema>>;
      readonly required?: ReadonlyArray<string>;
      readonly additionalProperties?: JsonSchema;
    };
    if (node.const !== undefined) return JSON.stringify(node.const);
    if (node.enum !== undefined) return node.enum.map((value) => JSON.stringify(value)).join(" | ");
    const alternatives = node.anyOf ?? node.oneOf;
    if (alternatives !== undefined) {
      return [...new Set(alternatives.map((member) => json(member, indent)))].join(" | ");
    }
    if (Array.isArray(node.type)) {
      return node.type.map((type) => json({ ...node, type }, indent)).join(" | ");
    }
    switch (node.type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array": {
        const item = json(node.items, indent);
        return `ReadonlyArray<${item}>`;
      }
      case "object":
      case undefined: {
        if (node.type === undefined && node.properties === undefined) return "unknown";
        const inner = `${indent}  `;
        const required = new Set(node.required ?? []);
        const lines = Object.entries(node.properties ?? {}).flatMap(([name, property]) => [
          ...comment(
            typeof property === "object"
              ? (property as { readonly description?: string }).description
              : undefined,
            inner,
          ),
          `${inner}readonly ${key(name)}${required.has(name) ? "" : "?"}: ${json(property, inner)};`,
        ]);
        if (typeof node.additionalProperties === "object") {
          lines.push(`${inner}readonly [key: string]: ${json(node.additionalProperties, inner)};`);
        }
        return shape(lines, indent, true);
      }
      default:
        return "unknown";
    }
  };

  /** A tool's arguments or result, from either kind of schema. */
  const of = (schema: Schema.Top | JsonSchema | undefined, indent: string): string =>
    isSchema(schema) ? type(schema.ast, indent) : json(schema, indent);

  return { named, type, body, failures, of };
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
    const args = scope.of(tool.parameters, inner);
    const parameters = args === "{}" ? "" : `args: ${args}`;
    const success = tool.success === undefined ? "string" : scope.of(tool.success, inner);
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
    for (const entry of scope.named.values()) {
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

/** A failure class as a program finds it: `tools.bank.InsufficientFunds`. */
export interface ManifestClass {
  /** The namespaces the class is in, under `tools`. */
  readonly path: ReadonlyArray<string>;
  readonly name: string;
  readonly tag: string;
}

/** A tool as a program calls it. */
export interface ManifestTool {
  /** Its namespaces under `tools`, then its own name. */
  readonly path: ReadonlyArray<string>;
  /** Its name where scripts run. */
  readonly callAs: string;
  /** The class of each failure it declares, by `_tag`. */
  readonly failures: Readonly<Record<string, string>>;
}

/** What `tools` holds at run time: the same names {@link renderDeclarations} declares. */
export interface Manifest {
  readonly tools: ReadonlyArray<ManifestTool>;
  readonly classes: ReadonlyArray<ManifestClass>;
}

/** The tools and failure classes of `tools`, by where a program finds them. */
export const manifestOf = (tools: Omit<DeclaredNamespace, "name">): Manifest => {
  const out: { tools: ManifestTool[]; classes: ManifestClass[] } = { tools: [], classes: [] };
  const visit = (namespace: Omit<DeclaredNamespace, "name">, path: ReadonlyArray<string>) => {
    const scope = makeScope(["tools", ...path].join("."));
    const declared = new Set<string>();
    for (const tool of namespace.tools ?? []) {
      const failures: Record<string, string> = {};
      scope.failures(tool.failure?.ast);
      for (const entry of scope.named.values()) {
        if (entry.kind !== "error") continue;
        const tag = fieldsOf(entry.ast).tag ?? entry.name;
        if (!declared.has(entry.name)) {
          declared.add(entry.name);
          out.classes.push({ path, name: entry.name, tag });
        }
      }
      for (const name of scope.failures(tool.failure?.ast)) {
        const entry = scope.named.get(name);
        if (entry !== undefined) failures[fieldsOf(entry.ast).tag ?? entry.name] = entry.name;
      }
      out.tools.push({
        path: [...path, toIdentifier(tool.name)],
        callAs: tool.callAs ?? tool.name,
        failures,
      });
    }
    for (const child of namespace.namespaces ?? []) {
      visit(child, [...path, toIdentifier(child.name)]);
    }
  };
  visit(tools, []);
  return out;
};
