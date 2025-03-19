import type { Output } from "./output";

export type Inputs<P extends any[]> = P extends [infer First, ...infer Rest]
  ? [Input<First>, ...Inputs<Rest>]
  : [];

export type Input<T = any> =
  | T
  | Output<T>
  | (T extends any[] ? Inputs<T> : never)
  | (T extends string | number | boolean ? Output<T> : never)
  | (T extends object
      ? {
          [k in keyof T]: Input<T[k]>;
        }
      : never);
