export type IsAny<T> = 0 extends 1 & T ? true : false;

export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;
