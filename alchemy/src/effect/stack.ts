import type { Effect } from "effect/Effect";
import type { Bound } from "./bind.ts";
import type { Simplify } from "./util.ts";

export declare function stack<T extends Effect<any>[]>(
  ...args: T
): Effect<Simplify<Stack<T>>>;

export type Stack<T extends any[], accum = {}> = T extends [
  infer E,
  ...infer Rest,
]
  ? E extends Effect<infer A, any, any>
    ? Stack<
        Rest,
        {
          [K in keyof A]: K extends keyof accum
            ? accum[K] extends Bound<infer R, infer B>
              ? Bound<R, B | (A[K] extends Bound<any, infer B2> ? B2 : never)>
              : A[K]
            : A[K];
        } & Omit<accum, keyof A>
      >
    : never
  : accum;
