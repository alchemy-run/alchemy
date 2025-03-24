import type { Bindings } from "./cloudflare";
import type { Input } from "./input";
import type { Resource } from "./resource";
import type { Secret } from "./secret";

export function isPromise<T>(value: any): value is Promise<T> {
  return value && typeof value.then === "function";
}

export function isOutput<T>(value: any): value is Output<T> {
  return (
    value && typeof value === "object" && typeof value.apply === "function"
  );
}

export function output<T, P>(
  id: string,
  props: P,
  f: (props: Resolved<P>) => Promise<T>,
): Output<T> {
  // TODO: wrap `f` and evaluate props
  return f as any;
}

export type Outputs<P extends readonly any[]> = P extends [
  infer First,
  ...infer Rest,
]
  ? [Output<First>, ...Outputs<Rest>]
  : [];

export type Output<T> = {
  dependOn<This>(this: This, value: any): This;
} & Promise<T> &
  (T extends object
    ? {
        [k in keyof T]: Output<T[k]>;
      }
    : Promise<T>);

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

type A = Resolved<Input<Bindings>>;
declare const a: A;

const b = a;

export type Resolved<O> = O extends Date
  ? Date
  : O extends Resource<string>
    ? O
    : O extends Output<infer U>
      ? U
      : O extends Promise<infer U>
        ? U
        : O extends Secret
          ? Secret
          : O extends null
            ? O
            : O extends any[]
              ? number extends O["length"]
                ? O extends Array<infer I>
                  ? Resolved<I>[]
                  : never
                : ResolveN<O>
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
