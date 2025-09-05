// A policy is invariant over its allowed actions
export interface Policy<in out Statements extends Statement = any> {
  readonly statements: Statements[];
}

export declare namespace Policy {
  // collapses Policy<A> | Policy<B> | Policy<C> into Policy<A | B | C>
  export type Normalize<T> =
    | Exclude<T, Policy>
    | Policy<Extract<T, Policy>["statements"][number]>;
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
