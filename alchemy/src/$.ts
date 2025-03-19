import type { Input } from "./input";
import { type Output, OutputChain } from "./output";
import { getScope } from "./scope";

export type $<T> = T extends
  | undefined
  | null
  | boolean
  | number
  | string
  | symbol
  | bigint
  ? Input<T>
  : T extends (...args: infer Args extends any[]) => infer R
    ? (
        ...args: {
          [i in keyof Args]: $<Args[i]>;
        }
      ) => Output<Awaited<R>>
    : T extends any[]
      ? $array<T>
      : $object<T>;

type $object<T> = {
  [i in keyof T]: $<T[i]>;
};
type $array<T extends any[]> = T extends [infer First, ...infer Rest]
  ? [$<First>, ...$object<Rest>]
  : [];

export function $<T>(value: T): $<T> {
  return new Proxy(() => {}, {
    apply: (_: T, thisArg, args) => {
      const target = value as (...args: any[]) => any;
      let argsOutput: Output<any[]> | undefined;
      for (const arg of args) {
        if (arg instanceof OutputChain) {
          if (argsOutput) {
            argsOutput = arg.apply((arg) =>
              argsOutput!.apply((...args) => [...args, arg]),
            );
          } else {
            argsOutput = arg.apply((arg) => [arg]);
          }
        } else {
          if (argsOutput) {
            argsOutput = argsOutput.apply((args) => [...args, arg]);
          } else {
            argsOutput = new OutputChain({} as any, () => [arg]);
          }
        }
      }

      const scope = getScope();
      const output = argsOutput
        ? argsOutput.apply((args) => target(...args))
        : new OutputChain({} as any, () => target());
      scope.callbacks.push(output);
      return $(output);
    },
    get: (_: any, prop) => {
      const target = value as any;
      if (target instanceof OutputChain) {
        return $(target.apply((t) => t[prop]));
      }
      return $(target[prop]);
    },
  });
}
