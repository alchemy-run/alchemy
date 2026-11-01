import { ConfigError } from "@distilled.cloud/core/errors";
import { ForgejoCredentials, forgejoCredentialsOf } from "@distilled.cloud/stackit/Forgejo";
import type * as forgejo from "@distilled.cloud/stackit/git_forgejo";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import { CurrentRuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as StackitBindings from "../StackitBindings.ts";
import type { BindingScope } from "./BindingScope.ts";
import type { Instance } from "./Instance.ts";
import type { Repository } from "./Repository.ts";
import type { Runner } from "./Runner.ts";

/**
 * Shared HTTP scaffolding for STACKIT Git bindings.
 * NOT exported from index.ts.
 *
 * Two APIs, two kinds of access:
 *
 * - The management API takes a STACKIT identity, through `StackitBindings`. Each binding grants a
 *   custom role with the permission the spec's `x-stackit-authorization` names for its operation,
 *   on the project holding the instance. STACKIT binds roles on nothing narrower.
 * - A repository is behind the instance's Forgejo API, which takes no STACKIT identity. Those
 *   bindings put the repository's own login in the host's env through `RuntimeContext`, on any host.
 *   They deliberately skip `StackitBindings.Bind`: it would also create a service account and key
 *   the host has no use for.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.Git.GetInstance`. */
  tag: string;
  /** The permission the spec names for the operation. */
  permission: string;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** A binding on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <I extends { projectId: string; instanceId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      instanceId: instance.instanceId,
    }),
    grants: (instance) => [
      StackitBindings.grantOn(instance, { permissions: [options.permission] }),
    ],
  });

/** A binding on the runner of an instance. */
export const makeRunnerHttpBinding = <I extends { projectId: string; instanceId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (runner: Runner) => ({
      projectId: runner.projectId,
      instanceId: runner.instanceId,
    }),
    grants: (runner) => [StackitBindings.grantOn(runner, { permissions: [options.permission] })],
  });

/** A binding on the whole project of the bound resource. */
export const makeProjectHttpBinding = <I extends { projectId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({ projectId: scope.projectId }),
    grants: (scope) => [StackitBindings.grantOn(scope, { permissions: [options.permission] })],
  });

/** The parts of a repository's login, each its own env var on the host. */
const LOGIN_PARTS = ["token", "username", "password"] as const;
type LoginPart = (typeof LOGIN_PARTS)[number];

const loginEnvKey = (repository: ResourceLike, part: LoginPart) =>
  sanitizeKey(`ALCHEMY_STACKIT_GIT_${repository.LogicalId}_${part.toUpperCase()}`);

const toOutput = (value: unknown) => (Output.isOutput(value) ? value : Output.literal(value));

/** A secret given as plain text stays out of the host's env and logs as text. */
const asEnvValue = (part: LoginPart, value: unknown) =>
  part !== "username" && typeof value === "string" ? Redacted.make(value) : value;

/**
 * Put a repository's login in the host's env, at deploy. With no host (a script) there is no
 * runtime context, and nothing to set.
 */
const bindLogin = Effect.fn(function* (repository: Repository) {
  const runtime = yield* CurrentRuntimeContext;
  if (runtime === undefined) return;
  const { Props: props }: ResourceLike = repository;
  for (const part of LOGIN_PARTS) {
    const value = props?.[part];
    if (value === undefined) continue;
    yield* runtime.set(loginEnvKey(repository, part), toOutput(asEnvValue(part, value)));
  }
});

/** A host's env can hand a secret back unwrapped, whatever its type says. */
const fromEnv = (value: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

/**
 * The host's `ForgejoCredentials` value for a bound repository. It holds only text, read when the
 * layer is built, and the instance's URL is read on each call. With no login in the env (a script),
 * each call fails with `ConfigError`.
 */
const hostCredentials = Effect.fn(function* (
  repository: Repository,
  instanceUrl: Effect.Effect<string>,
) {
  const runtime = yield* CurrentRuntimeContext;
  const read = <T>(part: LoginPart): Effect.Effect<T | undefined> =>
    globalThis.__ALCHEMY_RUNTIME__ && runtime !== undefined
      ? runtime.get<T>(loginEnvKey(repository, part))
      : Effect.undefined;
  const token = yield* read<string | Redacted.Redacted<string>>("token");
  const username = yield* read<string>("username");
  const password = yield* read<string | Redacted.Redacted<string>>("password");
  const auth =
    token !== undefined
      ? { token: fromEnv(token) }
      : username !== undefined && password !== undefined
        ? { username, password: fromEnv(password) }
        : undefined;
  if (auth === undefined) {
    return Effect.fail(
      new ConfigError({
        message: `No Forgejo login is bound for STACKIT Git repository ${repository.LogicalId}: repository bindings only run inside a host.`,
      }),
    );
  }
  return Effect.flatMap(instanceUrl, (url) => forgejoCredentialsOf({ instanceUrl: url, auth }));
});

/** A binding over one Forgejo operation on a repository: `<Op>Http.ts` is one call to it. */
export const makeRepositoryBinding = <I extends { owner: string; repo: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.Git.GetRepository`. */
  tag: string;
  /** The distilled operation; the repository's owner and name are injected. */
  operation: (input: I) => Effect.Effect<A, E, forgejo.ForgejoOpContext>;
}) =>
  Effect.succeed(
    Effect.fn(function* (repository: Repository) {
      const owner = yield* repository.owner;
      const repo = yield* repository.repositoryName;
      const instanceUrl = yield* repository.instanceUrl;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bindLogin(repository);
      }
      const credentials = yield* hostCredentials(repository, instanceUrl);
      return Effect.fn(`${options.tag}(${repository.LogicalId})`)(function* (
        request: Omit<I, "owner" | "repo">,
      ) {
        const fields = { owner: yield* owner, repo: yield* repo };
        // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
        return yield* options
          .operation({ ...request, ...fields } as unknown as I)
          .pipe(
            Effect.provideService(ForgejoCredentials, credentials),
            Effect.provide(FetchHttpClient.layer),
          );
      });
    }),
  );
