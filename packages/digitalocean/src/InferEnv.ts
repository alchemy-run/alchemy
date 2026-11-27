import type * as Effect from "effect/Effect";

/**
 * Typed `env` for an async (non-Effect) {@link App}. App Platform passes
 * bindings and `env` entries as environment variables, so every entry is a
 * `string`: the `process.env` object the handler receives as its second
 * argument.
 *
 * @example
 * ```typescript
 * export const Ping = DigitalOcean.App("Ping", {
 *   main: "./src/ping.ts",
 *   env: { GREETING: "hello" },
 * });
 * export type PingEnv = DigitalOcean.InferEnv<typeof Ping>;
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
