import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { UserFacingError } from "./UserFacingError.ts";

/** Input passed to a stack's configured secret manager. */
export interface SecretManagerResolveOptions {
  /** Name of the Alchemy stack being resolved. */
  readonly stack: string;
  /** Concrete Alchemy stage, when the command addresses a stack instance. */
  readonly stage?: string;
}

/** Public service contract implemented by stack secret-manager layers. */
export interface SecretManagerService {
  /** Human-readable implementation name used in diagnostics. */
  readonly name: string;
  /** Resolve the manager-owned ConfigProvider for one stack session. */
  readonly resolve: (
    options: SecretManagerResolveOptions,
  ) => Effect.Effect<ConfigProvider.ConfigProvider, SecretManagerError>;
}

/**
 * A deploy-time source of validated configuration for an Alchemy stack.
 * Alchemy's default ConfigProvider is available through Effect `Config` while
 * `resolve` runs and is composed beneath the returned provider afterward.
 */
export class SecretManager extends Context.Service<
  SecretManager,
  SecretManagerService
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

/** @internal Resolve an optional stack secret manager over the default provider. */
export const resolveSecretManagerConfig = Effect.fn(
  "SecretManager.resolveConfig",
)(function* (options: {
  readonly secrets?: SecretManagerLayer;
  readonly stack: string;
  readonly stage?: string;
  readonly fallback: ConfigProvider.ConfigProvider;
}) {
  if (options.secrets === undefined) return options.fallback;
  const context = yield* Layer.build(options.secrets);
  const managed = yield* Effect.provideService(
    Context.get(context, SecretManager).resolve({
      stack: options.stack,
      stage: options.stage,
    }),
    ConfigProvider.ConfigProvider,
    options.fallback,
  );
  return ConfigProvider.orElse(managed, options.fallback);
});
