import type { Node } from "./types.ts";

/** Every `Domain.<Noun>(...)` building block, plus `RpcMiddleware.Service` (`Middleware`). */
export type Kind =
  | "Aggregate"
  | "Command"
  | "Event"
  | "Rejection"
  | "View"
  | "Policy"
  | "Saga"
  | "Projection"
  | "Stream"
  | "ExternalSystem"
  | "Api"
  | "Model"
  | "RequestContext"
  | "Middleware";

export const KINDS: ReadonlySet<string> = new Set<Kind>([
  "Aggregate",
  "Command",
  "Event",
  "Rejection",
  "View",
  "Policy",
  "Saga",
  "Projection",
  "Stream",
  "ExternalSystem",
  "Api",
  "Model",
  "RequestContext",
  "Middleware",
]);

/** The kinds a file is named after (`<Noun>.<suffix>.ts`): one of them per file. */
export const PRIMARY_SUFFIX: Readonly<Partial<Record<Kind, string>>> = {
  Aggregate: "aggregate",
  Command: "command",
  View: "view",
  Policy: "policy",
  Saga: "saga",
  Projection: "projection",
  Stream: "stream",
  ExternalSystem: "external",
  Api: "api",
  Model: "model",
  RequestContext: "context",
  Middleware: "middleware",
};

export const DOMAIN_MODULE = "@alchemy.run/domain";

/** Visit `node` and every node below it. Return `false` from `visit` to skip a subtree. */
export const walk = (node: Node | undefined, visit: (node: Node) => boolean | void): void => {
  if (node === undefined || node === null || typeof node.type !== "string") return;
  if (visit(node) === false) return;
  for (const key in node) {
    if (key === "parent") continue;
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && typeof child.type === "string") {
          walk(child as Node, visit);
        }
      }
    } else if (value && typeof value === "object" && typeof (value as Node).type === "string") {
      walk(value as Node, visit);
    }
  }
};

/** `a.b` → `["a", "b"]`; `a.b.c` → `["a", "b", "c"]`; anything else → `undefined`. */
export const memberPath = (node: Node | undefined): Array<string> | undefined => {
  if (node === undefined) return undefined;
  if (node.type === "Identifier") return [node.name];
  if (node.type === "ThisExpression") return ["this"];
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    const object = memberPath(node.object);
    return object === undefined ? undefined : [...object, node.property.name];
  }
  if (node.type === "TSNonNullExpression" || node.type === "ChainExpression") {
    return memberPath(node.expression);
  }
  return undefined;
};

export const isMember = (node: Node | undefined, object: string, property?: string): boolean => {
  const path = memberPath(node);
  return (
    path !== undefined &&
    path.length === 2 &&
    path[0] === object &&
    (property === undefined || path[1] === property)
  );
};

/** Strip `as`, `satisfies`, `!` and parentheses. */
export const unwrap = (node: Node | undefined): Node | undefined => {
  let current = node;
  while (
    current !== undefined &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "ParenthesizedExpression" ||
      current.type === "TSTypeAssertion")
  ) {
    current = current.expression;
  }
  return current;
};

export const propertyName = (property: Node): string | undefined => {
  if (property.type !== "Property" || property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value;
  }
  return undefined;
};

/** The `name: value` property of an object literal. */
export const getProperty = (object: Node | undefined, name: string): Node | undefined => {
  const target = unwrap(object);
  if (target?.type !== "ObjectExpression") return undefined;
  return target.properties.find((property: Node) => propertyName(property) === name);
};

/** The identifiers of an array literal (`[A, B]`). */
export const arrayIdentifiers = (node: Node | undefined): Array<Node> => {
  const target = unwrap(node);
  if (target?.type !== "ArrayExpression") return [];
  return target.elements.filter((element: Node | null) => element?.type === "Identifier");
};

export const isRelative = (source: string): boolean =>
  source === "." || source === ".." || source.startsWith("./") || source.startsWith("../");

/** What a file imports: local name → module specifier and imported name. */
export interface ImportBinding {
  readonly source: string;
  /** The exported name, `*` for a namespace import, `default` for a default import. */
  readonly imported: string;
  readonly typeOnly: boolean;
}

export const importBindings = (program: Node): Map<string, ImportBinding> => {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const typeOnly = statement.importKind === "type";
    for (const specifier of statement.specifiers) {
      const imported =
        specifier.type === "ImportNamespaceSpecifier"
          ? "*"
          : specifier.type === "ImportDefaultSpecifier"
            ? "default"
            : specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : String(specifier.imported.value);
      bindings.set(specifier.local.name, {
        source: statement.source.value,
        imported,
        typeOnly: typeOnly || specifier.importKind === "type",
      });
    }
  }
  return bindings;
};

/**
 * The building-block kind a callee constructs, if any:
 * `Domain.Aggregate`, a named `Aggregate` import from `@alchemy.run/domain`,
 * `Aggregate.make` from `@alchemy.run/domain/Aggregate`, or `RpcMiddleware.Service`.
 */
export const calleeKind = (
  callee: Node | undefined,
  imports: ReadonlyMap<string, ImportBinding>,
): Kind | undefined => {
  const target = unwrap(callee);
  if (target === undefined) return undefined;
  // `Domain.RequestContext<X>()(...)` and `RpcMiddleware.Service<X, Y>()(...)` are curried.
  if (target.type === "CallExpression") return calleeKind(target.callee, imports);
  const path = memberPath(target);
  if (path === undefined) return undefined;
  const binding = imports.get(path[0]!);
  if (path.length === 1) {
    if (binding?.source === DOMAIN_MODULE && KINDS.has(binding.imported)) {
      return binding.imported as Kind;
    }
    return undefined;
  }
  if (path.length !== 2) return undefined;
  const member = path[1]!;
  if (binding === undefined) {
    // An un-imported `Domain.X` (e.g. a global or a snippet): accept the conventional name.
    if (path[0] === "Domain" && KINDS.has(member)) return member as Kind;
    return undefined;
  }
  if (binding.imported === "*" && binding.source === DOMAIN_MODULE && KINDS.has(member)) {
    return member as Kind;
  }
  if (
    binding.imported === "*" &&
    binding.source.startsWith(`${DOMAIN_MODULE}/`) &&
    member === "make"
  ) {
    const module = binding.source.slice(DOMAIN_MODULE.length + 1);
    if (KINDS.has(module)) return module as Kind;
  }
  if (
    member === "Service" &&
    ((binding.imported === "*" && binding.source.includes("RpcMiddleware")) ||
      binding.imported === "RpcMiddleware")
  ) {
    return "Middleware";
  }
  return undefined;
};

/** A building block declared in a file: `class X extends Domain.Aggregate(...) {}` or `const X = Domain.Event(...)`. */
export interface Block {
  readonly name: string;
  readonly kind: Kind;
  /** The class or variable id, to report on. */
  readonly id: Node;
  /** The `Domain.X(name, definition)` call. */
  readonly call: Node;
  /** The definition object (`call.arguments[1]`), when it is an object literal. */
  readonly definition: Node | undefined;
}

const blockFrom = (
  id: Node,
  init: Node | undefined,
  imports: ReadonlyMap<string, ImportBinding>,
): Block | undefined => {
  const call = unwrap(init);
  if (call?.type !== "CallExpression") return undefined;
  const kind = calleeKind(call.callee, imports);
  if (kind === undefined) return undefined;
  const definition = unwrap(call.arguments[1]);
  return {
    name: id.name,
    kind,
    id,
    call,
    definition: definition?.type === "ObjectExpression" ? definition : undefined,
  };
};

/** The top-level building blocks of a file, in source order. */
export const fileBlocks = (
  program: Node,
  imports: ReadonlyMap<string, ImportBinding>,
): Array<Block> => {
  const blocks: Array<Block> = [];
  for (const raw of program.body) {
    const statement =
      (raw.type === "ExportNamedDeclaration" || raw.type === "ExportDefaultDeclaration") &&
      raw.declaration
        ? raw.declaration
        : raw;
    if (
      (statement.type === "ClassDeclaration" || statement.type === "ClassExpression") &&
      statement.id &&
      statement.superClass
    ) {
      const block = blockFrom(statement.id, statement.superClass, imports);
      if (block) blocks.push(block);
    } else if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        const block = blockFrom(declarator.id, declarator.init, imports);
        if (block) blocks.push(block);
      }
    }
  }
  return blocks;
};

const isFunction = (node: Node | undefined): boolean =>
  node !== undefined &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration");

/**
 * The function a handler value runs: the value itself, or the function inside
 * `Effect.fn(function* ...)` / `Effect.fn("name")(function* ...)` / `Effect.gen(function* ...)`.
 */
export const handlerFunction = (value: Node | undefined): Node | undefined => {
  const target = unwrap(value);
  if (target === undefined) return undefined;
  if (isFunction(target)) return target;
  if (target.type === "CallExpression") {
    const fn = target.arguments.find((argument: Node) => isFunction(argument));
    if (fn) return fn;
    return handlerFunction(target.callee);
  }
  return undefined;
};

/** Top-level functions of a file by name, so a rule can follow a call into a local helper. */
export const localFunctions = (program: Node): Map<string, Node> => {
  const functions = new Map<string, Node>();
  for (const raw of program.body) {
    const statement =
      raw.type === "ExportNamedDeclaration" && raw.declaration ? raw.declaration : raw;
    if (statement.type === "FunctionDeclaration" && statement.id) {
      functions.set(statement.id.name, statement);
    } else if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        const init = unwrap(declarator.init);
        if (init === undefined) continue;
        if (isFunction(init)) functions.set(declarator.id.name, init);
        else if (init.type === "CallExpression") {
          const fn = handlerFunction(init);
          if (fn) functions.set(declarator.id.name, fn);
        }
      }
    }
  }
  return functions;
};

/**
 * Walk `root`, and every local helper it calls (transitively, once each).
 * Returns the helpers it entered, so a rule can say "reached through `helper`".
 */
export const walkWithHelpers = (
  root: Node,
  helpers: ReadonlyMap<string, Node>,
  visit: (node: Node, via: string | undefined) => void,
): void => {
  const seen = new Set<Node>();
  const go = (node: Node, via: string | undefined) => {
    if (seen.has(node)) return;
    seen.add(node);
    walk(node, (child) => {
      visit(child, via);
      if (child.type === "CallExpression" && child.callee.type === "Identifier") {
        const helper = helpers.get(child.callee.name);
        if (helper && !seen.has(helper)) go(helper, via ?? child.callee.name);
      }
    });
  };
  go(root, undefined);
};

/** Text of a node, for messages. */
export const textOf = (source: string, node: Node, max = 40): string => {
  const text = source.slice(node.start, node.end).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * Why `node` reads the clock or randomness, or `undefined`.
 * `Date.now()`, `new Date()`, `Date()`, `Math.random()`, `crypto.randomUUID()`,
 * `crypto.getRandomValues()`, `performance.now()`, `Clock.*`, `Random.*`, `DateTime.now*`.
 */
export const nondeterminism = (node: Node): string | undefined => {
  if (node.type === "NewExpression") {
    if (
      node.callee.type === "Identifier" &&
      node.callee.name === "Date" &&
      node.arguments.length === 0
    ) {
      return "new Date()";
    }
    return undefined;
  }
  if (node.type === "CallExpression") {
    const callee = unwrap(node.callee);
    if (callee?.type === "Identifier" && callee.name === "Date") return "Date()";
    const path = memberPath(callee);
    if (path === undefined) return undefined;
    const tail = path.slice(-2).join(".");
    const [object, method] = path.slice(-2);
    if (tail === "Date.now") return "Date.now()";
    if (tail === "Math.random") return "Math.random()";
    if (tail === "performance.now") return "performance.now()";
    if (object === "crypto" && (method === "randomUUID" || method === "getRandomValues")) {
      return `crypto.${method}()`;
    }
    return undefined;
  }
  if (node.type === "MemberExpression") {
    const path = memberPath(node);
    // `Clock.currentTimeMillis`, `Random.next`, `DateTime.now`, `DateTime.nowUnsafe()`:
    // reported on the member, so a call is not reported twice.
    if (path?.length === 2 && (path[0] === "Clock" || path[0] === "Random")) {
      return `${path[0]}.${path[1]}`;
    }
    if (path?.length === 2 && path[0] === "DateTime" && path[1]!.startsWith("now")) {
      return `DateTime.${path[1]}`;
    }
  }
  return undefined;
};

/** Why `node` does I/O, or `undefined`: `fetch`, `process`, timers, `Effect.promise`/`tryPromise`. */
export const io = (node: Node): string | undefined => {
  if (node.type === "CallExpression") {
    const callee = unwrap(node.callee);
    const path = memberPath(callee);
    if (path === undefined) return undefined;
    const name = path.join(".");
    if (name === "fetch" || name === "globalThis.fetch") return "fetch()";
    if (
      name === "setTimeout" ||
      name === "setInterval" ||
      name === "setImmediate" ||
      name === "queueMicrotask"
    ) {
      return `${name}()`;
    }
    if (name === "Effect.promise" || name === "Effect.tryPromise") return name;
    if (name.startsWith("console.")) return name;
    return undefined;
  }
  if (node.type === "Identifier" && node.name === "process") {
    const parent = node.parent;
    // Skip `x.process` and `{ process: ... }` keys.
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) {
      return undefined;
    }
    if (parent?.type === "Property" && parent.key === node && !parent.computed) return undefined;
    return "process";
  }
  return undefined;
};
