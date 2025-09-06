import type { Effect } from "effect/Effect";
import type { Bound } from "./bind.ts";
import type { Simplify } from "./util.ts";

export declare function stack<Name extends string, T extends Effect<any>[]>(
  name: Name,
  ...args: T
): Stack<Name, Simplify<_Stack<T>>>;

export type Stack<Name extends string, T> = Effect<
  T & { $stack: Name },
  never,
  never
>;

type _Stack<T extends any[], accum = {}> = T extends [infer E, ...infer Rest]
  ? E extends Effect<infer A, any, any>
    ? _Stack<
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
