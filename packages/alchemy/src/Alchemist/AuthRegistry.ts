import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { AuthError, AuthProviders } from "../Auth/AuthProvider.ts";
import { SuppressMissingProviderConfig } from "../Auth/Profile.ts";
import * as Contributions from "../Contributions.ts";
import type { ContributionError } from "../Contributions.ts";
import { UserFacingError } from "../UserFacingError.ts";
import { makeCachedFunction } from "../Util/cached-function.ts";
import { DEFAULT_ENTRYPOINT, importStack } from "./Entrypoint.ts";
import * as Operations from "./Operations.ts";
import type { Services } from "./Runtime.ts";

// Every auth provider a project can reach: what `alchemy profile` and
// `alchemy provider check-env` list and configure. Collected by building the
// installed providers' auth and the project's providers into one registry.

/** What collecting an auth registry can fail with. */
export type CollectAuthProvidersError =
  | AuthError
  | AuthProviderImportError
  | ContributionError
  | PlatformError;

/** What collecting an auth registry runs under. */
export type CollectAuthProvidersServices = Services | Scope.Scope;

type CollectAuthProviders = (
  options: CollectAuthProvidersOptions,
) => Effect.Effect<
  AuthProviders["Service"],
  CollectAuthProvidersError,
  CollectAuthProvidersServices
>;

export interface CollectAuthProvidersOptions {
  readonly main: string;
  readonly envFile: Option.Option<string>;
  readonly profile: string;
}

/**
 * Every provider's auth provider, merged into one registering layer. One
 * provider whose auth fails to load is skipped with a warning, so it can't
 * take every other provider's auth down with it.
 */
const contributedAuth = Effect.gen(function* () {
  const layers = yield* Effect.forEach(
    yield* Contributions.load(),
    (provider) =>
      provider.auth
        ? Contributions.resolve(provider, "auth", provider.auth).pipe(
            Effect.catch((error) => Effect.as(Effect.logWarning(error.message), Layer.empty)),
          )
        : Effect.succeed(Layer.empty),
    { concurrency: "unbounded" },
  );
  return Layer.mergeAll(Layer.empty, ...layers);
});

/** Register every installed provider's auth into the ambient registry. */
const registerContributedAuth = Effect.fn("registerContributedAuth")(function* (options: {
  readonly envFile: Option.Option<string>;
  readonly profile: string;
}) {
  const shared = yield* Operations.configServices({
    ...options,
    envFile: Option.getOrUndefined(options.envFile),
  });
  yield* Layer.build(Layer.provide(yield* contributedAuth, shared));
});

const isMissingProviderConfig = Schema.is(
  Schema.Struct({ _tag: Schema.Literals(["MissingProviderConfig"]) }),
);

/** `Name [code]: message` for an error-shaped value, or `undefined`. */
const describeError = (error: unknown): string | undefined => {
  if (!Predicate.hasProperty(error, "message") || typeof error.message !== "string") {
    return undefined;
  }
  const name =
    Predicate.hasProperty(error, "name") && typeof error.name === "string" ? error.name : "Error";
  const code =
    Predicate.hasProperty(error, "code") && typeof error.code === "string"
      ? ` [${error.code}]`
      : "";
  return error.message === "" ? `${name}${code}` : `${name}${code}: ${error.message}`;
};

const describeValue = (value: unknown): string =>
  describeError(value) ?? (typeof value === "string" ? value : Formatter.format(value));

/**
 * Renders an error's `cause` chain on one line, with an `AggregateError`'s
 * members in parentheses. Duck-typed rather than `instanceof Error`: Bun's
 * `ResolveMessage` and `BuildMessage`, which a failed import throws, are not
 * `Error` instances.
 */
const describeCauseChain = (error: unknown): string => {
  const reasons: string[] = [];
  let current = error;
  for (let depth = 0; current != null && depth < 8; depth++) {
    const described = describeError(current);
    if (described === undefined) {
      reasons.push(describeValue(current));
      break;
    }
    const members =
      Predicate.hasProperty(current, "errors") && Array.isArray(current.errors)
        ? current.errors
        : [];
    reasons.push(
      members.length > 0 ? `${described} (${members.map(describeValue).join(", ")})` : described,
    );
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return reasons.join("; caused by ");
};

/** The stack entrypoint failed to load, so its auth providers can't be registered. */
export class AuthProviderImportError extends Data.TaggedError("AuthProviderImportError")<{
  readonly main: string;
  readonly cause: unknown;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `Could not load auth providers from '${this.main}': ${describeCauseChain(this.cause)}`;
  }
}

/**
 * Every auth provider reachable from the current project: the built-ins, plus
 * whatever the user's stack module registers when it is importable.
 */
const collectAuthProvidersUncached = Effect.fn("collectAuthProvidersUncached")(
  function* (options: CollectAuthProvidersOptions) {
    // Everything built below registers into this one registry: the
    // registry layers reuse an ambient registry instead of starting fresh.
    const authProviders: AuthProviders["Service"] = {};
    const collect = Effect.provideService(AuthProviders, authProviders);
    yield* registerContributedAuth(options).pipe(collect);

    const fs = yield* FileSystem.FileSystem;
    const entrypointExists = yield* fs.exists(options.main);
    const missingDefault = options.main === DEFAULT_ENTRYPOINT && !entrypointExists;
    if (!entrypointExists && !missingDefault) {
      return yield* AuthError.make({
        message: `Stack entrypoint '${options.main}' does not exist.`,
      });
    }
    if (!missingDefault) {
      yield* importStack(options.main).pipe(
        Effect.flatMap((stack) =>
          Operations.buildProviders(stack, {
            profile: options.profile,
            envFile: Option.getOrUndefined(options.envFile),
          }),
        ),
        collect,
        Effect.timeoutOption(Duration.seconds(15)),
        Effect.catchCause((cause) => {
          const suppressed = cause.reasons.some((reason) => {
            const error = Cause.isFailReason(reason)
              ? reason.error
              : Cause.isDieReason(reason)
                ? reason.defect
                : undefined;
            return isMissingProviderConfig(error);
          });
          return suppressed
            ? Effect.void
            : Effect.fail(
                new AuthProviderImportError({ main: options.main, cause: Cause.squash(cause) }),
              );
        }),
      );
    }
    return authProviders;
  },
  Effect.provideService(SuppressMissingProviderConfig, true),
);

/**
 * Collects auth registries. Uncached by default; {@link authRegistryLayer}
 * memoizes them for its own lifetime.
 */
const AuthRegistry = Context.Reference<CollectAuthProviders>("Alchemy/Alchemist/AuthRegistry", {
  defaultValue: () => collectAuthProvidersUncached,
});

/**
 * Memoize auth registries for one command or API runtime: profile flows
 * collect them repeatedly, and concurrent collections of the same project
 * share one. Registries are built in this layer's scope, so a cached one
 * never outlives the services its providers captured. Failures are not
 * cached.
 */
export const authRegistryLayer = Layer.effect(
  AuthRegistry,
  Effect.map(Effect.scope, (scope) =>
    makeCachedFunction(
      (options: CollectAuthProvidersOptions) =>
        collectAuthProvidersUncached(options).pipe(Scope.provide(scope)),
      {
        key: ([options]) =>
          JSON.stringify([options.main, Option.getOrNull(options.envFile), options.profile]),
      },
    ),
  ),
);

export const collectAuthProviders = (options: CollectAuthProvidersOptions) =>
  Effect.flatMap(AuthRegistry, (collect) => collect(options));
