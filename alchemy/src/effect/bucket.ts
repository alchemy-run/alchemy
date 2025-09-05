import type * as Effect from "effect/Effect";
import type { Instance } from "./ctor.ts";
import type { Allow, Policy } from "./policy.ts";

export type Bucket<ID extends string = any> = {
  type: "Bucket";
  id: ID;
  new (
    _: never,
  ): {
    type: "Bucket";
    id: ID;
  };
  get<Self, const Key extends string = string>(
    this: Self,
    key: Key,
  ): Effect.Effect<
    string | undefined,
    never,
    Policy<Bucket.Get<Instance<Self>, Key>>
  >;
  put<Self, const Key extends string = string>(
    this: Self,
    key: Key,
    value: string,
  ): Effect.Effect<void, never, Policy<Bucket.Put<Instance<Self>, Key>>>;
};

export declare function Bucket<ID extends string>(id: ID): Bucket<ID>;

export declare namespace Bucket {
  export type Get<B, Key extends string> = Allow<
    B,
    "Bucket::Get",
    { key: Key }
  >;
  export function Get<B, const Key extends string>(
    bucket: B,
    key?: Key,
  ): Policy<Get<Instance<B>, Key>>;
  export function Get<B, const Key extends string>(
    bucket: B,
    key?: Key,
  ): Policy<Get<Instance<B>, Key>>;

  export type Put<B, Key extends string> = Allow<
    B,
    "Bucket::Put",
    { key: Key }
  >;
  export function Put<B, const Key extends string = string>(
    bucket: B,
    key?: Key,
  ): Policy<Put<Instance<B>, Key>>;
}
