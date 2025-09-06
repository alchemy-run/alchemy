import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Policy, Statement } from "./policy.ts";

export type Bind<S extends Statement> = <
  E extends Effect.Effect<any, never, Policy<S>>,
>(
  effect: E,
) => Layer.Layer<never, never, never>;

export declare function bind<S extends readonly Policy[]>(
  ...actions: S
): Bind<S[number]["statements"][number]>;

export declare function policy<S extends readonly Policy[]>(
  ...actions: S
): Policy<
  | Extract<S[number], Policy>["statements"][number]
  | Extract<S[number], Statement>
>;
