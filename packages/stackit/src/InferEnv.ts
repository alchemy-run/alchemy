import type * as Effect from "effect/Effect";

/**
 * Typed `env` for an async (non-Effect) STACKIT workload: a
 * `Stackit.Functions.Function`, `Stackit.ContainerApplications.Application` or
 * `Stackit.IaaS.Service`, whose handler receives it as its second argument, or a `Kubernetes.Deployment` on a
 * `Stackit.SKE.Cluster` whose `main` is an ordinary server file. A container only has environment variables, so every entry
 * is a `string`, read from `process.env`.
 *
 * @example
 * ```typescript
 * export const Ping = Stackit.Functions.Function("Ping", {
 *   main: "./src/ping.ts",
 *   registry: { repository: "ghcr.io/my-org/ping" },
 *   env: { GREETING: "hello" },
 * });
 * export type PingEnv = Stackit.InferEnv<typeof Ping>;
 * ```
 *
 * @example
 * ```typescript
 * export const Api = Kubernetes.Deployment("Api", {
 *   cluster: Stackit.SKE.Cluster.ref("Cluster"),
 *   main: "./src/server.ts",
 *   port: 3000,
 *   env: { GREETING: "hello" },
 * });
 * export type ApiEnv = Stackit.InferEnv<typeof Api>;
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
