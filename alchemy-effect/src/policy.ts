import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { type AnyBinding, type Bind } from "./binding.ts";
import type { Capability } from "./capability.ts";
import type { Runtime } from "./runtime.ts";

/**
 * A Policy binds a set of Capbilities (e.g SQS.SendMessage, SQS.Consume, etc.) to a
 * specific Runtime (e.g. AWS Lambda Function, Cloudflare Worker, etc.).
 *
 * It brings with it a set of upstream Tags containing the required Provider services
 * to deploy the infrastructure, e.g. (BindingTag<AWS.Lambda.Function, SendMessage<Queue>>)
 *
 * A Policy is invariant over the set of Capabilities to ensure least-privilege.
 */
export interface Policy<
  F extends Runtime,
  in out Capabilities,
  Tags = unknown,
> {
  readonly runtime: F;
  readonly tags: Tags[];
  readonly capabilities: Capabilities[];
  // phantom property (exists at runtime but not in types)
  // readonly bindings: AnyBinding[];
  /** Add more Capabilities to a Policy */
  and<B extends AnyBinding[]>(
    ...bindings: B
  ): Policy<F, B[number]["capability"] | Capabilities, Tags>;
}

export type $<T> = Instance<T>;
export const $ = Policy;

type BindingTags<B extends AnyBinding> = B extends any
  ? Bind<B["runtime"], B["capability"], Extract<B["tag"], string>>
  : never;

export function Policy<F extends Runtime>(): Policy<F, never, never>;
export function Policy<B extends AnyBinding[]>(
  ...capabilities: B
): Policy<
  B[number]["runtime"],
  B[number]["capability"],
  BindingTags<B[number]>
>;
export function Policy(...bindings: AnyBinding[]): any {
  return {
    runtime: bindings[0]["runtime"],
    capabilities: bindings.map((b) => b.capability),
    tags: bindings.map((b) => Context.Tag(b.tag as any)()),
    bindings,
    and: (...b2: AnyBinding[]) => Policy(...bindings, ...b2),
  } as Policy<any, any, any> & {
    // add the phantom property
    bindings: AnyBinding[];
  };
}

export namespace Policy {
  export interface AnyOf<in out T> {
    readonly anyOf: T[];
  }
  type Generalize<T> = T extends S.Schema<infer U> ? U : T;

  export const anyOf = <const T>(...anyOf: T[]): AnyOf<Generalize<T>> => ({
    anyOf: anyOf as Generalize<T>[],
  });

  export const join = <
    const Strings extends readonly string[],
    const Delimiter extends string,
  >(
    strings: Strings,
    delimiter: Delimiter,
  ) => strings.join(delimiter) as Join<Strings, Delimiter>;

  type ___ = Join<string[], ",">;
  type Join<
    T extends readonly string[],
    Delimiter extends string,
  > = T extends readonly [infer First extends string]
    ? First
    : T extends readonly [
          infer First extends string,
          ...infer Rest extends readonly string[],
        ]
      ? `${First}${Delimiter}${Join<Rest, Delimiter>}`
      : T extends string[]
        ? string
        : "";

  export type Constraint<T> = Pick<
    T,
    {
      [k in keyof T]: T[k] extends never
        ? never
        : T[k] extends AnyOf<never>
          ? never
          : k;
    }[keyof T]
  >;

  // TODO(sam): one day we might infer policies using a compiler plugin, this is a placeholder
  export const infer = <T>(): T => undefined!;
}

/** declare a Policy requiring Capabilities in some context */
export const declare = <S extends Capability>() =>
  Effect.gen(function* () {}) as Effect.Effect<void, never, S>;

export type Instance<T> = T extends { id: string }
  ? string extends T["id"]
    ? T
    : T extends new (...args: any) => infer I
      ? I
      : never
  : never;
// syntactic sugar for mapping `typeof Messages` -> Messages, e.g. so it's SQS.SendMessage<Messages> instead of SQS.SendMessage<typeof Messages>
// e.g. <Q extends SQS.Queue>(queue: Q) => SQS.SendMessage<To<Q>>
export type From<T> = Instance<T>;
export type To<T> = Instance<T>;
export type In<T> = Instance<T>;
export type Into<T> = Instance<T>;
export type On<T> = Instance<T>;
