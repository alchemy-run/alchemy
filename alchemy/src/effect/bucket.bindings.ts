import type { R2Bucket } from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import { binding } from "./binding.ts";
import type { Bucket } from "./bucket.ts";
import type { Instance } from "./ctor.ts";
import type { Env } from "./env.ts";
import type { Allow, Policy } from "./policy.ts";

const Binding = binding<R2Bucket>();

export type Resource<ID extends string> = Bucket<ID>;

export const Resource = <ID extends string>(id: ID): Bucket<ID> => {
  return class extends Context.Tag(id)<
    Bucket<ID>,
    {}
  >() {} as unknown as Bucket<ID>;
};

export type Get<B, Key extends string> = Allow<
  B,
  "Bucket::Get",
  { key: Key }
> & {
  get(key: Key): Effect.Effect<string | undefined, never, Env>;
};

export declare function Get<B, const Key extends string>(
  bucket: B,
  key?: Key,
): Policy<Get<Instance<B>, Key>>;

export const get = <B extends Bucket, const Key extends string = string>(
  bucket: B,
  key: Key,
) => Binding.get<Get<Instance<B>, Key>>()(bucket, key);

export type Put<B, Key extends string> = Allow<B, "Bucket::Put", { key: Key }>;

export declare function Put<B, const Key extends string = string>(
  bucket: B,
  key?: Key,
): Policy<Put<Instance<B>, Key>>;

export const put = <B extends Bucket, const Key extends string = string>(
  bucket: B,
  key: Key,
  value: string,
) => Binding.put<Put<Instance<B>, Key>>()(bucket, key, value);
