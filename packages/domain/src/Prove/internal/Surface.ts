import * as Interpreter from "./Interpreter.ts";
import * as Known from "./Known.ts";
import type { Loader } from "./Source.ts";
import * as Value from "./Value.ts";

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
