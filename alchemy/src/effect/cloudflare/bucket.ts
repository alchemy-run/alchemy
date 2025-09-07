import type * as Effect from "effect/Effect";
import type { R2Bucket } from "../../cloudflare/bucket.ts";
import type { Instance } from "../ctor.ts";
import type { Policy } from "../policy.ts";
import type { Get, Put } from "./bucket.bindings.ts";

export * as Bucket from "./bucket.bindings.ts";

export type Bucket<ID extends string = any> = {
  type: "Bucket";
  id: ID;
  new (_: never): R2Bucket<ID>;
  get<Self, const Key extends string = string>(
    this: Self,
    key: Key,
  ): Effect.Effect<string | undefined, never, Policy<Get<Instance<Self>, Key>>>;
  put<Self, const Key extends string = string>(
    this: Self,
    key: Key,
    value: string,
  ): Effect.Effect<void, never, Policy<Put<Instance<Self>, Key>>>;
};
