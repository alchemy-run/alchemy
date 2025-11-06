import type { Policy } from "./policy";

export interface ICapability<
  Type extends string = string,
  Resource = unknown,
  Constraint = unknown,
> {
  type: Type;
  resource: Resource;
  constraint: Constraint;
  sid: string;
  label: string;
}

export interface Capability<
  Type extends string = string,
  Resource = unknown,
  Constraint = unknown,
> extends ICapability<Type, Resource, Constraint> {
  new (): {};
}

export declare namespace Capability {
  export type Simplify<C> = [C] extends [
    {
      Constructor: { Reduce: any };
    },
  ]
    ? _Reduce<C>
    : C;

  type _Reduce<C> = [C] extends [
    infer c extends { Constructor: any; resource: any; constraint: any },
  ]
    ? (c["Constructor"] & {
        resource: c["resource"];
        constraint: Constraint.Simplify<c["constraint"]>;
      })["Reduce"]
    : never;

  type KeysWithNever<T> = {
    [K in keyof T]: T[K] extends never | Policy.AnyOf<never> ? K : never;
  }[keyof T];
  type DropIrrelevant<T> = T extends any
    ? {
        [k in keyof Omit<T, KeysWithNever<T>>]: Omit<T, KeysWithNever<T>>[k];
      }
    : never;
  type Get<T, K extends string | number | symbol> = T extends {
    [k in K]: infer V;
  }
    ? V
    : never;
  type Keys<T> = T extends any ? keyof T : never;
  type BoxPolicy<T> = [T] extends [{ anyOf: (infer U)[] }]
    ? Policy.AnyOf<U>
    : never;
  export namespace Constraint {
    export type Simplify<Constraint> = {
      [k in Keys<DropIrrelevant<Constraint>>]: BoxPolicy<Get<Constraint, k>>;
    };
  }
}
