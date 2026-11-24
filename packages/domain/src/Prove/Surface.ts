import * as Interpreter from "./internal/Interpreter.ts";
import * as Known from "./internal/Known.ts";
import type { Loader } from "./internal/Source.ts";
import * as Syntax from "./internal/Syntax.ts";
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
  /** Every form of the language, by name: the ones the prover reads, and the ones it stops at. */
  syntax: {
    read: Syntax.FORMS.filter((form) => form.read).map((form) => form.name),
    unread: Syntax.FORMS.filter((form) => !form.read).map((form) => form.name),
  },
});

/**
 * The forms of the language a source text is written with, by the names
 * `surface().syntax` gives them. A piece of syntax that is on neither list
 * is `undeclared <its type>`.
 */
export const forms = async (source: string): Promise<ReadonlySet<string>> => {
  const oxc = await import("oxc-parser");
  const parsed = oxc.parseSync("surface.ts", source);
  if (parsed.errors.length > 0)
    throw new Error(`the source does not parse: ${parsed.errors[0]?.message ?? ""}: ${source}`);
  return Syntax.formsOf(parsed.program);
};

/** A source text as the tree the prover reads: what a test walks to find how a table calls a function. */
export const parse = async (source: string): Promise<unknown> => {
  const oxc = await import("oxc-parser");
  const parsed = oxc.parseSync("surface.ts", source);
  if (parsed.errors.length > 0)
    throw new Error(`the source does not parse: ${parsed.errors[0]?.message ?? ""}: ${source}`);
  return parsed.program;
};
