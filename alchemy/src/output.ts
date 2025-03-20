import type { Secret } from "./secret";

export function isOutput<T>(value: any): value is Output<T> {
  return (
    value && typeof value === "object" && typeof value.apply === "function"
  );
}

export type Outputs<P extends readonly any[]> = P extends [
  infer First,
  ...infer Rest,
]
  ? [Output<First>, ...Outputs<Rest>]
  : [];

export interface Output<T> {
  apply<U>(fn: (value: T) => U): Output<U>;
}

export class OutputChain<T, U> {
  public readonly fn: (value: T) => U;
  constructor(
    public readonly parent: Output<T>,
    fn: (value: T) => U,
  ) {
    let result:
      | {
          value: U;
        }
      | undefined;
    this.fn = (value: T) => {
      if (result === undefined) {
        result = {
          value: fn(value),
        };
      }
      return result.value as U;
    };
  }

  public apply<V>(fn: (value: U) => Output<V>): Output<V>;
  public apply<V>(fn: (value: U) => V): Output<V>;
  public apply<V>(fn: (value: U) => any): Output<V> {
    return new OutputChain(this, fn);
  }
}

export type Resolved<O> = O extends Output<infer U>
  ? U
  : O extends Secret
    ? Secret
    : O extends null
      ? O
      : O extends any[]
        ? ResolveN<O>
        : O extends object
          ? {
              [k in keyof O]: Resolved<O[k]>;
            }
          : O;

type ResolveN<O extends any[]> = O extends [infer First, ...infer Rest]
  ? [Resolved<First>, ...ResolveN<Rest>]
  : [];

// export data from a resource
export type Export<Out> = Out extends null
  ? Output<Out>
  : Out extends any[]
    ? Outputs<Out>
    : Out extends object
      ? {
          [k in keyof Out]: Output<Out[k]>;
        }
      : Output<Out>;
