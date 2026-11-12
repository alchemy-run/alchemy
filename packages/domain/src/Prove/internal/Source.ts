import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { Declaration, Import, Module, Node } from "./Value.ts";

/** A source file could not be read, parsed or loaded. */
export class LoadError extends Data.TaggedError("LoadError")<{
  readonly file: string;
  readonly message: string;
}> {}

export interface Loader {
  /** A source file, parsed and loaded. Each file is read once. */
  readonly load: (file: string) => Effect.Effect<Module, LoadError>;
  /**
   * Name the domain classes the caller holds: a model or an aggregate, and
   * every class it lists. A test runner may load a source file a second time,
   * as classes that are not the caller's. Where a loaded file exports one of
   * those, the loader gives the caller's class in its place.
   */
  readonly adopt: (root: unknown) => void;
}

/** What a domain class is and its name: two loads of one file give classes that agree on it. */
const identityOf = (value: unknown): string | undefined => {
  if (typeof value !== "function") return undefined;
  const cls = value as unknown as Readonly<Record<string, unknown>>;
  for (const key of ["modelName", "aggregateName", "policyName", "sagaName", "viewName", "tag"])
    if (typeof cls[key] === "string") return `${key} ${cls[key]}`;
  return undefined;
};

const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null || Array.isArray(value);
};

/** The domain classes a class lists, each with where it is listed. */
const listed = (root: unknown): ReadonlyArray<readonly [string, unknown]> => {
  const made: Array<readonly [string, unknown]> = [];
  const visit = (value: unknown, at: string, depth: number): void => {
    if (identityOf(value) !== undefined) made.push([at, value]);
    else if (depth < 4 && isPlain(value))
      for (const [key, field] of Object.entries(value)) visit(field, `${at}.${key}`, depth + 1);
  };
  // `class Bank extends Domain.Model(...)` has its fields on the class it extends.
  const fields = new Map<string, unknown>();
  for (
    let cls: unknown = root;
    typeof cls === "function" && cls !== Function.prototype;
    cls = Object.getPrototypeOf(cls)
  )
    for (const [key, field] of Object.entries(cls)) if (!fields.has(key)) fields.set(key, field);
  for (const [key, field] of fields) visit(field, key, 0);
  return made;
};

const lineStartsOf = (source: string): ReadonlyArray<number> => {
  const starts = [0];
  for (let at = source.indexOf("\n"); at >= 0; at = source.indexOf("\n", at + 1))
    starts.push(at + 1);
  return starts;
};

const nameOf = (node: Node | undefined): string | undefined =>
  node === undefined || node === null
    ? undefined
    : node.type === "Identifier"
      ? (node.name as string)
      : node.type === "Literal" && typeof node.value === "string"
        ? node.value
        : undefined;

const declare = (declarations: Map<string, Declaration>, node: Node): void => {
  if (node.type === "VariableDeclaration") {
    for (const declarator of node.declarations as ReadonlyArray<Node>) {
      const name = nameOf(declarator.id);
      if (name !== undefined)
        declarations.set(name, { _tag: "Const", init: declarator.init ?? undefined });
    }
  } else if (node.type === "FunctionDeclaration") {
    const name = nameOf(node.id);
    if (name !== undefined) declarations.set(name, { _tag: "Function", node });
  } else if (node.type === "ClassDeclaration") {
    const name = nameOf(node.id);
    if (name !== undefined) declarations.set(name, { _tag: "Class" });
  }
};

/**
 * Reads TypeScript the way the prover needs it: the syntax tree for function
 * bodies, and the loaded module for the classes, schemas and constants the
 * code refers to.
 */
export const loader: Effect.Effect<Loader, LoadError, FileSystem.FileSystem | Path.Path> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const oxc = yield* Effect.tryPromise({
      try: () => import("oxc-parser"),
      catch: (cause) =>
        new LoadError({
          file: "oxc-parser",
          message: `oxc-parser is not installed (it is an optional peer of @alchemy.run/domain): ${String(cause)}`,
        }),
    });
    const loaded = new Map<string, Module>();
    /** The caller's classes by what they are, and the classes of a second load they stand for. */
    const ours = new Map<string, Set<unknown>>();
    const twins = new Map<unknown, unknown>();

    const adopt: Loader["adopt"] = (root) => {
      const seen = new Set<unknown>();
      const visit = (value: unknown): void => {
        const identity = identityOf(value);
        if (identity === undefined || seen.has(value)) return;
        seen.add(value);
        ours.set(identity, (ours.get(identity) ?? new Set()).add(value));
        for (const [, child] of listed(value)) visit(child);
      };
      visit(root);
    };

    /** Pair a class of a second load with the caller's, and the classes each lists in the same place. */
    const pair = (theirs: unknown, mine: unknown): void => {
      if (theirs === mine || twins.has(theirs) || identityOf(theirs) !== identityOf(mine)) return;
      twins.set(theirs, mine);
      const places = new Map(listed(mine));
      for (const [at, child] of listed(theirs)) pair(child, places.get(at));
    };

    /** The caller's class a loaded value stands for, or the value. */
    const canonical = (value: unknown): unknown => {
      const identity = identityOf(value);
      if (identity === undefined) return value;
      const known = ours.get(identity);
      if (known?.has(value)) return value;
      // Two classes may share a tag: only a name one class carries says which one this is.
      if (!twins.has(value) && known?.size === 1) pair(value, [...known][0]);
      return twins.get(value) ?? value;
    };

    const resolve = Effect.fn(function* (from: string, specifier: string) {
      const base = path.resolve(path.dirname(from), specifier);
      if (/\.[cm]?[jt]sx?$/.test(base)) return base;
      for (const candidate of [`${base}.ts`, `${base}.tsx`, path.resolve(base, "index.ts")]) {
        if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
      }
      return base;
    });

    const load: Loader["load"] = Effect.fn(function* (file: string) {
      const known = loaded.get(file);
      if (known) return known;
      const failed = (step: string) => (cause: unknown) =>
        new LoadError({ file, message: `${step}: ${String(cause)}` });
      const source = yield* fs.readFileString(file).pipe(Effect.mapError(failed("cannot read")));
      const parsed = yield* Effect.try({
        try: () => oxc.parseSync(file, source),
        catch: failed("cannot parse"),
      });
      if (parsed.errors.length > 0)
        return yield* new LoadError({
          file,
          message: `cannot parse: ${parsed.errors[0]!.message}`,
        });
      const url = yield* path.toFileUrl(file).pipe(Effect.mapError(failed("not a file path")));
      const namespace = yield* Effect.tryPromise({
        try: () => import(url.href) as Promise<Record<string, unknown>>,
        catch: failed("cannot load"),
      });
      const exports: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(namespace)) exports[name] = canonical(value);
      const program = parsed.program as unknown as Node;
      const declarations = new Map<string, Declaration>();
      const imports = new Map<string, Import>();
      const stars: Array<string> = [];
      const specifiers = new Set<string>();
      for (const statement of program.body as ReadonlyArray<Node>) {
        if (statement.type === "ImportDeclaration") {
          if (statement.importKind === "type") continue;
          const specifier = statement.source.value as string;
          specifiers.add(specifier);
          for (const spec of statement.specifiers as ReadonlyArray<Node>) {
            if (spec.importKind === "type") continue;
            const local = nameOf(spec.local);
            if (local === undefined) continue;
            imports.set(local, {
              specifier,
              imported:
                spec.type === "ImportNamespaceSpecifier"
                  ? "*"
                  : spec.type === "ImportDefaultSpecifier"
                    ? "default"
                    : (nameOf(spec.imported) ?? local),
            });
          }
        } else if (statement.type === "ExportNamedDeclaration") {
          if (statement.exportKind === "type") continue;
          if (statement.declaration) declare(declarations, statement.declaration);
          else if (statement.source) {
            const specifier = statement.source.value as string;
            specifiers.add(specifier);
            for (const spec of statement.specifiers as ReadonlyArray<Node>) {
              const exported = nameOf(spec.exported);
              const local = nameOf(spec.local);
              if (exported !== undefined && local !== undefined)
                imports.set(exported, { specifier, imported: local });
            }
          }
        } else if (statement.type === "ExportAllDeclaration") {
          if (statement.exportKind === "type" || statement.exported) continue;
          stars.push(statement.source.value as string);
          specifiers.add(statement.source.value as string);
        } else declare(declarations, statement);
      }
      const resolved = new Map<string, string>();
      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) resolved.set(specifier, yield* resolve(file, specifier));
      }
      const module: Module = {
        path: file,
        lineStarts: lineStartsOf(source),
        program,
        declarations,
        imports,
        stars,
        resolved,
        exports,
      };
      loaded.set(file, module);
      return module;
    });

    return { load, adopt };
  });
