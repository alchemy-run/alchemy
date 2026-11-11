import type { PropsInput } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { isResource } from "alchemy/Resource";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";

type Leaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Redacted.Redacted<any>
  | Uint8Array
  | Date
  | ((...args: any[]) => any);

/**
 * A prop value, or the declaration of a resource that has it: `template: Node`
 * instead of `template: yield* Node`, at any depth.
 */
export type Declared<T> = T extends Leaf
  ? T
  : T extends Output.Output<any>
    ? T
    : T extends ReadonlyArray<infer U>
      ? Declared<U>[] | Effect.Effect<T, never, Providers>
      : { [K in keyof T]: Declared<T[K]> } | Effect.Effect<T, never, Providers>;

/** Props where any value may be a resource declaration. */
export type DeclaredProps<P> = { [K in keyof PropsInput<P>]: Declared<PropsInput<P>[K]> };

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * A declaration still to be yielded: an Effect that isn't an Output, a
 * resource, or a Config (which the engine resolves as a prop value).
 */
export const isDeclaration = (value: unknown): value is Effect.Effect<unknown, never, Providers> =>
  Effect.isEffect(value) &&
  !Output.isOutput(value) &&
  !isResource(value) &&
  !Config.isConfig(value);

const hasDeclarations = (value: unknown): boolean =>
  isDeclaration(value) ||
  (Array.isArray(value) && value.some(hasDeclarations)) ||
  (isPlain(value) && !isResource(value) && Object.values(value).some(hasDeclarations));

/** Yield every declaration in `value`, at any depth. */
export const resolveDeclarations = (value: unknown): Effect.Effect<unknown, never, Providers> =>
  isDeclaration(value)
    ? value
    : Array.isArray(value)
      ? Effect.forEach(value, resolveDeclarations)
      : isPlain(value) && !isResource(value) && hasDeclarations(value)
        ? Effect.map(
            Effect.forEach(Object.entries(value), ([key, entry]) =>
              Effect.map(resolveDeclarations(entry), (resolved) => [key, resolved] as const),
            ),
            Object.fromEntries,
          )
        : Effect.succeed(value);

/**
 * Let a resource's props hold declarations of other resources, which are
 * yielded when the resource is: `Boat.Sandbox("Box", { snapshot: Golden })`.
 * Props without declarations are passed through unchanged.
 */
export const declarable =
  <R extends { readonly Props: any }>() =>
  <C extends object>(
    resource: C,
  ): C & ((id: string, props: DeclaredProps<R["Props"]>) => Effect.Effect<R, never, Providers>) =>
    new Proxy(resource as C & ((...args: unknown[]) => unknown), {
      apply: (target, self, args: unknown[]) =>
        typeof args[0] === "string" && hasDeclarations(args[1])
          ? Reflect.apply(target, self, [args[0], resolveDeclarations(args[1])])
          : Reflect.apply(target, self, args),
    }) as never;
