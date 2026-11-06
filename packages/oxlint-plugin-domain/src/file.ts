import {
  type Block,
  type ImportBinding,
  type Kind,
  arrayIdentifiers,
  fileBlocks,
  getProperty,
  importBindings,
  localFunctions,
  unwrap,
} from "./ast.ts";
import { moduleIndex, resolveImport } from "./files.ts";
import type { Context, Node } from "./types.ts";

/** One file's view of the model: its imports, its blocks, and the kind of every name it uses. */
export interface DomainFile {
  readonly program: Node;
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly blocks: ReadonlyArray<Block>;
  readonly helpers: ReadonlyMap<string, Node>;
  /** The kind of a name: declared here, or exported by the relative module it is imported from. */
  kindOf(name: string): Kind | undefined;
  /** The original name of a local name (`import { A as B }` → `A`). */
  originalName(name: string): string;
  /** The `rejects` a command, view or saga lists, as original names; `undefined` when unknown. */
  rejectsOf(name: string): ReadonlyArray<string> | undefined;
}

const SUFFIX_KIND: Readonly<Record<string, Kind>> = {
  rejection: "Rejection",
  aggregate: "Aggregate",
  command: "Command",
  view: "View",
  policy: "Policy",
  saga: "Saga",
  projection: "Projection",
  stream: "Stream",
  external: "ExternalSystem",
  api: "Api",
  model: "Model",
  context: "RequestContext",
  middleware: "Middleware",
};

/**
 * The names a `rejects` property lists: `[]` without one, `undefined` when it
 * is not an array of plain names (`rejects: shared`, `[...shared, A]`).
 */
export const rejectsNames = (property: Node | undefined): ReadonlyArray<string> | undefined => {
  if (property === undefined) return [];
  const value = unwrap(property.value);
  if (value?.type !== "ArrayExpression") return undefined;
  const ids = arrayIdentifiers(value);
  return ids.length === value.elements.length ? ids.map((id) => id.name) : undefined;
};

/**
 * A test file (`*.test.ts`, `*.spec.ts`). Tests declare models inline, so the
 * file layout rules skip them.
 */
export const isTestFile = (file: string): boolean => /\.(?:test|spec)\.[cm]?tsx?$/.test(file);

/** `./Account/Account.aggregate.ts` → `Aggregate`. */
export const kindOfPath = (file: string): Kind | undefined => {
  const match = /\.([a-z]+)(?:\.[cm]?[jt]sx?)?$/.exec(file);
  return match ? SUFFIX_KIND[match[1]!] : undefined;
};

export const domainFile = (context: Context, program: Node): DomainFile => {
  const imports = importBindings(program);
  const blocks = fileBlocks(program, imports);
  const byName = new Map(blocks.map((block) => [block.name, block]));
  const helpers = localFunctions(program);

  const imported = (name: string) => {
    const binding = imports.get(name);
    if (binding === undefined || binding.imported === "*") return undefined;
    const file = resolveImport(context.filename, binding.source);
    return { binding, file, index: file === undefined ? undefined : moduleIndex(file) };
  };

  return {
    program,
    imports,
    blocks,
    helpers,
    kindOf(name) {
      const local = byName.get(name);
      if (local) return local.kind;
      const found = imported(name);
      if (found === undefined) return undefined;
      return found.index?.kinds.get(found.binding.imported) ?? kindOfPath(found.binding.source);
    },
    originalName(name) {
      const binding = imports.get(name);
      return binding && binding.imported !== "*" && binding.imported !== "default"
        ? binding.imported
        : name;
    },
    rejectsOf(name) {
      const local = byName.get(name);
      if (local) {
        if (local.definition === undefined) return undefined;
        const listed = rejectsNames(getProperty(local.definition, "rejects"));
        return listed?.map((name) => this.originalName(name));
      }
      const found = imported(name);
      return found?.index?.rejects.get(found.binding.imported);
    },
  };
};
