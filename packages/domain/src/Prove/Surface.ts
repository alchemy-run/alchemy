import * as Interpreter from "./internal/Interpreter.ts";
import * as Known from "./internal/Known.ts";
import type { Loader } from "./internal/Source.ts";
import * as Value from "./internal/Value.ts";

/**
 * What the prover reads, by name: every library function and value it has a
 * model for, every method of a string and of an array, and every module
 * whose functions it runs as they are on values the code writes. The tests
 * hold a case for each name, compared with the real code.
 */
export const surface = () => ({
  // Nothing is loaded to list the names: no file is read.
  ...Interpreter.make({} as Loader, new Value.Run([])).surface,
  computed: Known.modules,
});

/**
 * Every kind of syntax a source text is written with: each node's type, and
 * for an operator, the type with the operator (`BinaryExpression +`).
 */
export const kinds = async (source: string): Promise<ReadonlySet<string>> => {
  const oxc = await import("oxc-parser");
  const parsed = oxc.parseSync("surface.ts", source);
  if (parsed.errors.length > 0)
    throw new Error(`the source does not parse: ${parsed.errors[0]?.message ?? ""}`);
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== "object" || node === null) return;
    const { type, operator, kind } = node as {
      readonly type?: unknown;
      readonly operator?: unknown;
      readonly kind?: unknown;
    };
    if (typeof type === "string") {
      found.add(type);
      if (typeof operator === "string") found.add(`${type} ${operator}`);
      if (type === "VariableDeclaration" && typeof kind === "string") found.add(`${type} ${kind}`);
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parsed.program);
  return found;
};
