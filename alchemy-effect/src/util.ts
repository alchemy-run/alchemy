export type IsAny<T> = 0 extends 1 & T ? true : false;

export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

export const assertDefined = <T>(value: T | undefined, message: string): T => {
  if (!value) {
    throw new Error(message);
  }
  return value;
};
