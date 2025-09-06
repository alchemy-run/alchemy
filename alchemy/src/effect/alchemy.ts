import type { Effect } from "effect/Effect";
import type { Policy } from "./policy.ts";

export * from "./bind.ts";

export declare function resource<A, E, R>(
  e: Effect<A, E, R>,
): Effect<A, never, Policy.Collect<R>>;

export declare function plan(input: any): any;
export declare function deploy(input: any): any;

export declare function stack<T extends Effect<any>[]>(
  ...args: T
): Effect<Simplify<Stack<T>>>;

type Stack<T extends any[], accum = {}> = T extends [infer E, ...infer Rest]
  ? E extends Effect<infer A, any, any>
    ? Stack<Rest, { [K in keyof A]: A[K] } & accum>
    : never
  : accum;

// typefest
type Simplify<T> = T extends infer U ? { [K in keyof U]: U[K] } : never;
