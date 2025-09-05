import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { Instance } from "./ctor.ts";
import type { Allow, Policy } from "./policy.ts";

export type KVNamespace<
  ID extends string = string,
  Key extends string = string,
  Value extends string = string,
> = {
  type: "KVNamespace";
  id: ID;
  get<Self>(
    this: Self,
    key: Key,
  ): Effect.Effect<
    Value | undefined,
    never,
    Policy<KVNamespace.Get<Instance<Self>>>
  >;
  put<Self>(
    this: Self,
    key: Key,
    value: Value,
  ): Effect.Effect<void, never, Policy<KVNamespace.Put<Instance<Self>>>>;
  new (
    _: never,
  ): {
    type: "KVNamespace";
    id: ID;
  };
};

export declare function KVNamespace<ID extends string>(
  id: ID,
): <
  Key extends string = string,
  Value extends string = string,
>() => KVNamespace<ID, Key, Value>;
export declare function KVNamespace<
  ID extends string,
  Key extends string = string,
  Value extends string = string,
>(
  id: ID,
  options: {
    key: Schema.Schema<Key>;
    value: Schema.Schema<Value>;
  },
): KVNamespace<ID, Key, Value>;

export declare namespace KVNamespace {
  export type Get<KV> = Allow<KV, "KV::Get">;
  export function Get<KV extends KVNamespace>(
    _kv: KV,
  ): Policy<Get<Instance<KV>>>;

  export type Put<KV> = Allow<KV, "KV::Put">;
  export function Put<KV extends KVNamespace>(
    kv: KV,
  ): Policy<Put<Instance<KV>>>;
}
