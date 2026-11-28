import type * as Effect from "effect/Effect";

/**
 * Typed `env` for an async (non-Effect) {@link WebService}. Render passes
 * bindings and `env` entries as environment variables, so every entry is a
 * `string`: the `process.env` object the handler receives as its second
 * argument.
 *
 * @example
 * ```typescript
 * export const Ping = Render.WebService("Ping", {
 *   main: "./src/ping.ts",
 *   registryImage: "ghcr.io/org/ping",
 *   env: { GREETING: "hello" },
 * });
 * export type PingEnv = Render.InferEnv<typeof Ping>;
 * ```
 */
export type InferEnv<F> =
  F extends Effect.Effect<infer A, infer _E, infer _R>
    ? InferEnv<A>
    : F extends { readonly Props: { readonly env?: infer E } }
      ? InferEnvRecord<Exclude<E, undefined>>
      : InferEnvRecord<F>;

type InferEnvRecord<E> = {
  readonly [K in keyof E]: string;
};
