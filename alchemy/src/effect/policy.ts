import * as Effect from "effect/Effect";
import type { Env } from "./env.ts";

// A policy is invariant over its allowed actions
export interface Policy<in out Statements extends Statement = any> {
  readonly statements: Statements[];
}

export declare namespace Policy {
  // collapses Policy<A> | Policy<B> | Policy<C> into Policy<A | B | C>
  export type Normalize<T> = Exclude<T, Policy> | Collect<T>;

  // flters out non-Policy types and normalizes the final Policy
  export type Collect<T> = Policy<
    Extract<T, Policy>["statements"][number] | Extract<T, Statement>
  >;

  export type Resources<P extends Policy> = P["statements"][number]["resource"];
}

export type Statement<Resource = any, Action extends string = string> =
  | Allow<Resource, Action>
  | Deny<Resource, Action>;

export interface Allow<Resource, Action extends string, Condition = any> {
  effect: "Allow";
  action: Action;
  resource: Resource;
  condition?: Condition;
}

export interface Deny<Resource, Action extends string, Condition = any> {
  effect: "Deny";
  action: Action;
  resource: Resource;
  condition?: Condition;
}

export const allow = <S extends Statement>() =>
  Effect.gen(function* () {}) as Effect.Effect<void, never, S | Env>;
