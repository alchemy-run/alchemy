import { arrayEqualsUnordered } from "alchemy/Util/equal";

/** Whether two string lists hold the same members (order-insensitive; nullish is empty). */
export const sameMembers = (
  a: ReadonlyArray<string> | null | undefined,
  b: ReadonlyArray<string> | null | undefined,
): boolean => arrayEqualsUnordered(a ?? [], b ?? []);
