import type * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { UserFacingError } from "./UserFacingError.ts";

/** Input passed to a stack's configured secret manager. */
export interface SecretManagerResolveOptions {
  /** Concrete Alchemy stage, when the command addresses a stack instance. */
  readonly stage?: string;
  /** Existing Alchemy config source used for values the manager does not resolve. */
  readonly fallback: ConfigProvider.ConfigProvider;
}

/** A deploy-time source of validated configuration for an Alchemy stack. */
export class SecretManager extends Context.Service<
  SecretManager,
  {
    /** Human-readable implementation name used in diagnostics. */
    readonly name: string;
    /** Resolve the effective ConfigProvider for one stack session. */
    readonly resolve: (
      options: SecretManagerResolveOptions,
    ) => Effect.Effect<ConfigProvider.ConfigProvider, SecretManagerError>;
  }
>()("SecretManager") {}

/** A pluggable secret manager accepted by {@link StackProps.secrets}. */
export type SecretManagerLayer = Layer.Layer<SecretManager>;

/** A secret manager could not load or validate the stack configuration. */
export class SecretManagerError extends Schema.TaggedError<SecretManagerError>()(
  "SecretManagerError",
  {
    manager: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  readonly [UserFacingError] = true;
}

/** @internal Resolve an optional stack secret manager over an existing provider. */
export const resolveSecretManagerConfig = Effect.fn(
  "SecretManager.resolveConfig",
)(function* (options: {
  readonly secrets?: SecretManagerLayer;
  readonly stage?: string;
  readonly fallback: ConfigProvider.ConfigProvider;
}) {
  if (options.secrets === undefined) return options.fallback;
  const context = yield* Layer.build(options.secrets);
  return yield* Context.get(context, SecretManager).resolve({
    stage: options.stage,
    fallback: options.fallback,
  });
});
