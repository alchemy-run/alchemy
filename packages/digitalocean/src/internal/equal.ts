/**
 * Set equality for primitive elements: order and repeats do not matter. An
 * omitted list (`undefined` or `null`) is empty, so it equals `[]`.
 */
export const setEquals = <T>(
  a: ReadonlyArray<T> | null | undefined,
  b: ReadonlyArray<T> | null | undefined,
): boolean => {
  const members = new Set(a ?? []);
  const others = new Set(b ?? []);
  return members.size === others.size && [...members].every((member) => others.has(member));
};
