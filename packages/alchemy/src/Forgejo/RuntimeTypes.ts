import type * as Config from "effect/Config";
import type * as Effect from "effect/Effect";
import type * as Output from "../Output.ts";
import type * as Redacted from "effect/Redacted";
import type { Input } from "../Input.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/** A secret value, resource output, or deployment configuration value. */
export type ForgejoSecret =
  | Redacted.Redacted<string>
  | Output.Output<Redacted.Redacted<string>, never>
  | Config.Config<Redacted.Redacted<string>>;

/** Managed token rotation or explicitly identified external credentials. */
export type ForgejoBindingOptions =
  | {
      /** Omit to provision a repository-restricted token automatically. */
      readonly token?: undefined;
      /** Change to rotate the managed token create-first. */
      readonly rotation?: Input<string>;
      readonly credentialId?: never;
    }
  | {
      /** Externally managed token. Alchemy never creates or revokes it. */
      readonly token: ForgejoSecret;
      /** Stable, non-secret identifier, unique per credential on this host. */
      readonly credentialId: string;
      readonly rotation?: never;
    };

/** Preserve the SDK operation's result and typed errors, binding its target once. */
export type ForgejoMethod<
  F extends (...args: any[]) => Effect.Effect<any, any, any>,
> = (
  request: Omit<Parameters<F>[0], "owner" | "repo"> & {
    owner?: never;
    repo?: never;
  },
) => Effect.Effect<
  Effect.Success<ReturnType<F>>,
  Effect.Error<ReturnType<F>>,
  RuntimeContext
>;

export type OptionalForgejoMethod<
  F extends (...args: any[]) => Effect.Effect<any, any, any>,
> = (
  request?: Omit<Parameters<F>[0], "owner" | "repo"> & {
    owner?: never;
    repo?: never;
  },
) => Effect.Effect<
  Effect.Success<ReturnType<F>>,
  Effect.Error<ReturnType<F>>,
  RuntimeContext
>;
