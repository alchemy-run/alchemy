import type * as Effect from "effect/Effect";

/**
 * Typed `env` for an async (non-Effect) {@link Template} program. A
 * template program reads its bindings from environment variables, so every
 * entry is a `string`: cast `process.env` to it.
 *
 * @example
 * ```typescript
 * export const Worker = E2B.Template("Worker", {
 *   image: "node:22-bookworm",
 *   main: "./src/worker.mjs",
 *   env: { QUEUE_URL: queue.url },
 * });
 * export type WorkerEnv = E2B.InferEnv<typeof Worker>;
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
