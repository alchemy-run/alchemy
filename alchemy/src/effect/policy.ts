import * as Effect from "effect/Effect";

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

export type Statement<Action extends string = string, Resource = any> =
  | Allow<Action, Resource>
  | Deny<Action, Resource>;

export interface Allow<Action extends string, Resource, Condition = any> {
  effect: "Allow";
  action: Action;
  resource: Resource;
  condition?: Condition;
}

export interface Deny<Action extends string, Resource, Condition = any> {
  effect: "Deny";
  action: Action;
  resource: Resource;
  condition?: Condition;
}

export const allow = <S extends Statement>() =>
  Effect.gen(function* () {}) as Effect.Effect<void, never, S>;

export declare const of: <S extends Statement[]>(
  ...statement: S
) => Policy<S[number]>;
