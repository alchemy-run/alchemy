import * as Effect from "effect/Effect";
import type { Resource as _Resource } from "./resource.ts";

// A policy is invariant over its allowed actions
export interface Policy<in out Statements extends Statement = any> {
  readonly statements: Statements[];
}

export type Statement<
  Action extends string = string,
  Resource extends _Resource = _Resource,
> = Allow<Action, Resource> | Deny<Action, Resource>;

export interface Allow<
  Action extends string,
  Resource extends _Resource,
  Condition = any,
> {
  effect: "Allow";
  action: Action;
  resource: Resource;
  condition?: Condition;
}

export interface Deny<
  Action extends string,
  Resource extends _Resource,
  Condition = any,
> {
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
