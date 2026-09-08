import * as Config from "effect/Config";
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
  /** Whether this session uses local emulation, as in `alchemy dev`. */
  readonly dev?: boolean;
}

/** Application configuration selected by an adapter for explicit forwarding. */
export type SecretManagerBindings = Readonly<
  Record<string, Config.Config<unknown>>
>;

/** Configuration and optional application bindings resolved for one session. */
export interface SecretManagerResult<
  Bindings extends SecretManagerBindings = SecretManagerBindings,
> {
  readonly provider: ConfigProvider.ConfigProvider;
  /** Only these keys are exposed for spreading into a resource's environment. */
  readonly bindings?: Bindings;
}

/** Public service contract implemented by stack secret-manager layers. */
export interface SecretManagerService<
  Bindings extends SecretManagerBindings = SecretManagerBindings,
> {
  /** Human-readable implementation name used in diagnostics. */
  readonly name: string;
  /** Resolve the manager-owned ConfigProvider for one stack session. */
  readonly resolve: (
    options: SecretManagerResolveOptions,
  ) => Effect.Effect<
    ConfigProvider.ConfigProvider | SecretManagerResult<Bindings>,
    SecretManagerError
  >;
}

/**
 * A deploy-time source of validated configuration for an Alchemy stack.
 * Alchemy's default ConfigProvider is available through Effect `Config` during
 * layer construction and `resolve`, and is composed beneath the returned provider.
 */
export class SecretManager extends Context.Service<
  SecretManager,
  SecretManagerService
>()("SecretManager") {}

/** A pluggable secret manager accepted by {@link StackProps.secrets}. */
export type SecretManagerLayer = Layer.Layer<SecretManager, SecretManagerError>;

/** A typed adapter handle; use its layer in `secrets` and its bindings in `env`. */
export interface SecretManagerIntegration<
  Bindings extends SecretManagerBindings,
> {
  readonly layer: SecretManagerLayer;
  readonly bindings: Effect.Effect<Bindings, Config.ConfigError>;
}

/**
 * Create an adapter handle without erasing the binding names or Config types.
 * The adapter supplies a typed schema (or generated declarations); remote
 * metadata alone cannot provide TypeScript property inference.
 * Bindings are obtained from the current session without resolving again.
 */
export const makeSecretManager = <Bindings extends SecretManagerBindings>(
  service: SecretManagerService<Bindings>,
): SecretManagerIntegration<Bindings> => ({
  layer: Layer.succeed(SecretManager, service),
  bindings: Effect.gen(function* () {
    const resolved = yield* SecretManagerContext;
    if (resolved?.manager !== service || resolved.bindings === undefined) {
      return yield* Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `Secret manager '${service.name}' has no bindings in this stack session. Configure its layer in Stack secrets and return a bindings map.`,
          }),
        ),
      );
    }
    // The service identity above ties this session's result to the generic
    // service used to create this handle, rather than an unchecked caller cast.
    return resolved.bindings as Bindings;
  }),
});

interface ResolvedSecretManager {
  readonly provider: ConfigProvider.ConfigProvider;
  readonly manager?: SecretManagerService;
  readonly bindings?: SecretManagerBindings;
}

/** @internal Session-owned data, never mutable state on an adapter handle. */
export const SecretManagerContext = Context.Reference<
  ResolvedSecretManager | undefined
>("Alchemy/SecretManagerContext", { defaultValue: () => undefined });

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
export const resolveSecretManager = Effect.fn("SecretManager.resolve")(
  function* (options: {
    readonly secrets?: SecretManagerLayer;
    readonly stack: string;
    readonly stage?: string;
    readonly dev?: boolean;
    readonly fallback: ConfigProvider.ConfigProvider;
  }) {
    if (options.secrets === undefined)
      return { provider: options.fallback } satisfies ResolvedSecretManager;
    const context = yield* Layer.build(options.secrets).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, options.fallback),
    );
    const manager = Context.get(context, SecretManager);
    const managed = yield* Effect.provideService(
      manager.resolve({
        stack: options.stack,
        stage: options.stage,
        dev: options.dev,
      }),
      ConfigProvider.ConfigProvider,
      options.fallback,
    );
    const result = "provider" in managed ? managed : { provider: managed };
    return {
      ...result,
      manager,
      provider: ConfigProvider.orElse(result.provider, options.fallback),
    } satisfies ResolvedSecretManager;
  },
);

/** @internal Provider-only convenience for callers that do not consume bindings. */
export const resolveSecretManagerConfig = (
  options: Parameters<typeof resolveSecretManager>[0],
) =>
  resolveSecretManager(options).pipe(
    Effect.map((resolved) => resolved.provider),
  );
