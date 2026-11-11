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
}

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
      const exports = yield* Effect.tryPromise({
        try: () => import(url.href) as Promise<Record<string, unknown>>,
        catch: failed("cannot load"),
      });
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

    return { load };
  });
