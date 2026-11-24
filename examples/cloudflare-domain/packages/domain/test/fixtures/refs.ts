import * as Option from "effect/Option";

// Ids that hold structure, and the functions that take them apart. A test
// names them as opaque: the prover then takes each for what the code uses
// its result as, and the real function says what that is.

/** `"acct@3"` is the account `"acct"`. */
export const nameOf = (ref: string): string => ref.slice(0, ref.indexOf("@"));

/** `"acct@3"` is at version `3`. */
export const versionOf = (ref: string): Option.Option<number> => {
  const at = ref.lastIndexOf("@");
  const n = Number(ref.slice(at + 1));
  return at < 0 || !Number.isInteger(n) ? Option.none() : Option.some(n);
};

/** `"a,b"` names the accounts `"a"` and `"b"`. */
export const partsOf = (list: string): ReadonlyArray<string> =>
  list === "" ? [] : list.split(",");

/** How many accounts a list names. */
export const countOf = (list: string): number => partsOf(list).length;
