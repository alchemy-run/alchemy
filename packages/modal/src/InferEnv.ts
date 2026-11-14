import type * as Effect from "effect/Effect";

/**
 * The `process.env` an async `Modal.Sandbox` program sees: one string per
 * `env` entry of the declaration.
 *
 * @example
 * ```ts
 * // alchemy.run.ts
 * export const Agent = Modal.Sandbox("Agent", { main: "./src/agent.ts", app: Coder, env: { GREETING: "hi" } });
 * export type AgentEnv = Modal.InferEnv<typeof Agent>;
 *
 * // src/agent.ts
 * import type { AgentEnv } from "../alchemy.run.ts";
 * const env = process.env as unknown as AgentEnv;
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
