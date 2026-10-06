type Members<T> = ReadonlyArray<T> | null | undefined;

/** The distinct members of a list. An omitted list has none. */
export const unique = <T>(items: Members<T>): T[] => [...new Set(items ?? [])];

/** True when both lists hold the same members. Order and repeats do not matter. */
export const sameMembers = <T extends string | number>(a: Members<T>, b: Members<T>): boolean => {
  const members = new Set(a ?? []);
  const others = new Set(b ?? []);
  return members.size === others.size && [...members].every((member) => others.has(member));
};
