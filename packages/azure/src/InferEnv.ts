import type { Output } from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import type * as Config from "effect/Config";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

/**
 * Typed `env` for an async (non-Effect) `Azure.Functions.Function` or
 * `Azure.Web.WebApp`: the object the handler receives as its second argument.
 *
 * Azure bindings are app settings, so each entry is the decoded setting:
 *
 * - a string, a `Config` value, or an Output of a string → `string`
 *   (secrets arrive unwrapped)
 * - a resource → its attributes (e.g. a `Storage.BlobContainer` arrives as
 *   `{ containerName, storageAccount, … }`)
 * - any other JSON value → itself
 *
 * @example
 * ```typescript
 * export const Hello = Azure.Functions.Function("Hello", {
 *   main: "./src/hello.ts",
 *   env: { GREETING: "hello", UPLOADS: uploads },
 * });
 * export type HelloEnv = Azure.InferEnv<typeof Hello>;
 * // { readonly GREETING: string; readonly UPLOADS: { containerName: string; … } }
 * ```
 */
export type InferEnv<F> =
  F extends Effect.Effect<infer A, infer _E, infer _R>
    ? InferEnv<A>
    : F extends {
          readonly Type:
            | "Azure.Functions.Function"
            | "Azure.Web.FunctionApp"
            | "Azure.Web.WebApp"
            | "Azure.ContainerInstance.ContainerGroup"
            | "Azure.ContainerApps.ContainerApp"
            | "Azure.ContainerApps.Job"
            | "Azure.Compute.VirtualMachine";
          readonly Props: { readonly env?: infer E };
        }
      ? InferEnvRecord<Exclude<E, undefined>>
      : InferEnvRecord<F>;

type InferEnvRecord<E> = {
  readonly [K in keyof E]: EnvValue<E[K]>;
};

/** The decoded value of one `env` entry. */
export type EnvValue<T> =
  T extends Redacted.Redacted<any>
    ? string
    : T extends ResourceLike<string, any, infer Attributes>
      ? Readonly<Attributes>
      : T extends Output<infer A, infer _Req>
        ? EnvValue<A>
        : T extends Config.Config<infer A>
          ? EnvValue<A>
          : T extends Effect.Effect<infer A, infer _E, infer _R>
            ? EnvValue<A>
            : T extends string
              ? string
              : T;
