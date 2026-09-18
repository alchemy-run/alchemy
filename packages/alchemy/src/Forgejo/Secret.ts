import { Services } from "@distilled.cloud/forgejo";
import type { Secret as ApiSecret } from "@distilled.cloud/forgejo/repository";
import * as Effect from "effect/Effect";
import { discovered, requireOwnership } from "./Ownership.ts";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  type ActionsScope,
  actionsScope,
  listActionsEntries,
  sameScope,
} from "./ActionsScope.ts";
import { paginate } from "./Pagination.ts";
import type * as Forgejo from "./Providers.ts";

// The scope model is shared with the variable resource, so it lives in the
// internal `ActionsScope` module rather than in either resource. It is part
// of both resources' public props surface, so it is re-exported here — and
// only here, since `index.ts` star-exports both files and would otherwise
// see the same names twice.
export {
  type ActionsScope,
  type OrganizationActionsScope,
  type RepositoryActionsScope,
  sameScope,
  type UserActionsScope,
} from "./ActionsScope.ts";

/**
 * Legacy repository-scoped secret properties.
 */
export interface LegacySecretProps {
  /**
   * Repository owner.
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly repository: string;
  /**
   * Secret name.
   */
  readonly name: string;
  /**
   * Secret value.
   */
  readonly value: Redacted.Redacted<string>;
}

/**
 * Desired Forgejo Actions secret properties.
 */
export type SecretProps =
  | LegacySecretProps
  | {
      /**
       * Scope of this secret.
       */
      readonly scope: ActionsScope;
      /**
       * Secret name.
       */
      readonly name: string;
      /**
       * Secret value.
       */
      readonly value: Redacted.Redacted<string>;
    };
/**
 * Observed Forgejo Actions secret attributes.
 */
export interface SecretAttributes {
  /**
   * Scope of the secret.
   */
  readonly scope: ActionsScope;
  /**
   * Secret name.
   */
  readonly name: string;
  /**
   * When the value is known to have last been current.
   *
   * Forgejo's secret representation carries only `created_at` and never the
   * value, so there is nothing to compare a stored secret against: a deploy
   * stamps the time it wrote, while enumeration falls back to the instance's
   * `created_at`. Useful as a freshness hint, not as an equality key.
   */
  readonly updatedAt: string;
}

/**
 * A Forgejo Actions secret resource.
 */
export interface Secret extends Resource<
  "Forgejo.Secret",
  SecretProps,
  SecretAttributes,
  never,
  Forgejo.Providers
> {}
/**
 * A Forgejo Actions secret, scoped to a repository, an organization, or the
 * authenticated user.
 *
 * Forgejo accepts secret values as plaintext over authenticated TLS; unlike
 * GitHub there is no public-key encryption handshake. The stored value can
 * never be read back, so reconciliation writes it when scheduled. Repository
 * and organization secrets are discovered through their name lists and require
 * explicit adoption when not recorded in state. User secrets have no existence
 * API, so their initial upsert always requires `adopt(true)`. The API has no
 * conditional-create operation to guard against a concurrent secret writer.
 *
 * ### Creating a Secret
 * **Example:** Repository Secret
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * yield* Forgejo.Secret("deploy-token", {
 *   owner: "acme",
 *   repository: "api",
 *   name: "DEPLOY_TOKEN",
 *   value: Redacted.make(process.env.DEPLOY_TOKEN!),
 * });
 * ```
 *
 * ### Scoping a Secret
 * **Example:** Organization Secret
 * ```typescript
 * yield* Forgejo.Secret("registry", {
 *   scope: { kind: "organization", organization: "acme" },
 *   name: "REGISTRY_PASSWORD",
 *   value: Redacted.make(process.env.REGISTRY_PASSWORD!),
 * });
 * ```
 *
 * **Example:** User Secret
 * ```typescript
 * import { adopt } from "alchemy";
 *
 * yield* Forgejo.Secret("npm", {
 *   scope: { kind: "user" },
 *   name: "NPM_TOKEN",
 *   value: Redacted.make(process.env.NPM_TOKEN!),
 * }).pipe(adopt(true));
 * ```
 *
 * @resource
 */
export const Secret = Resource<Secret>("Forgejo.Secret");
/**
 * Resolve legacy and scoped secret properties into one scope.
 */
export const secretScope = (props: SecretProps): ActionsScope =>
  actionsScope(props);

/**
 * Forgejo has one secret endpoint family per scope, so each lifecycle step
 * dispatches on the scope kind.
 */
const putSecret = Effect.fn(function* (
  scope: ActionsScope,
  name: string,
  data: string,
) {
  if (scope.kind === "repository") {
    return yield* Services.repository.updateRepoSecret({
      owner: scope.owner,
      repo: scope.repository,
      secretname: name,
      data,
    });
  }
  if (scope.kind === "organization") {
    return yield* Services.organization.updateOrgSecret({
      org: scope.organization,
      secretname: name,
      data,
    });
  }
  return yield* Services.user.updateUserSecret({ secretname: name, data });
});

const deleteSecret = Effect.fn(function* (scope: ActionsScope, name: string) {
  if (scope.kind === "repository") {
    return yield* Services.repository.deleteRepoSecret({
      owner: scope.owner,
      repo: scope.repository,
      secretname: name,
    });
  }
  if (scope.kind === "organization") {
    return yield* Services.organization.deleteOrgSecret({
      org: scope.organization,
      secretname: name,
    });
  }
  return yield* Services.user.deleteUserSecret({ secretname: name });
});

const toAttributes = (
  scope: ActionsScope,
  secret: ApiSecret,
): SecretAttributes => ({
  scope,
  name: secret.name,
  updatedAt: secret.created_at,
});

const observeSecret = Effect.fn(function* (scope: ActionsScope, name: string) {
  if (scope.kind === "user") return undefined;
  const secrets = yield* (
    scope.kind === "repository"
      ? paginate(Services.repository.repoListActionsSecrets, {
          owner: scope.owner,
          repo: scope.repository,
        })
      : paginate(Services.organization.orgListActionsSecrets, {
          org: scope.organization,
        })
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as readonly ApiSecret[]),
    ),
  );
  return secrets.find(
    (secret) => secret.name.toUpperCase() === name.toUpperCase(),
  );
});

/**
 * Provider layer implementing Actions-secret lifecycle.
 */
export const SecretProvider = () =>
  Provider.succeed(Secret, {
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (!sameScope(secretScope(news), secretScope(olds)) ||
            news.name !== olds.name)
          ? { action: "replace" as const }
          : undefined,
      ),
    // User-scoped secrets are deliberately absent from the sweep: Forgejo
    // exposes `/user/actions/secrets/{name}` for PUT and DELETE but has no
    // collection endpoint to enumerate them, unlike the repository,
    // organization, and user-variable collections. A user-scoped secret
    // therefore has to be destroyed through the stack that declared it.
    list: () =>
      listActionsEntries({
        repository: (scope) =>
          paginate(Services.repository.repoListActionsSecrets, {
            owner: scope.owner,
            repo: scope.repository,
          }).pipe(
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed([] as readonly ApiSecret[]),
            ),
          ),
        organization: (scope) =>
          paginate(Services.organization.orgListActionsSecrets, {
            org: scope.organization,
          }).pipe(
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed([] as readonly ApiSecret[]),
            ),
          ),
        toAttributes,
      }),
    read: Effect.fn(function* ({ olds, output }) {
      const scope = secretScope(olds);
      // User secrets have no existence API: explicit adoption authorizes the upsert.
      if (scope.kind === "user")
        return discovered(
          output ?? { scope, name: olds.name, updatedAt: "" },
          output !== undefined,
        );
      const observed = yield* observeSecret(scope, olds.name);
      return observed === undefined
        ? undefined
        : discovered(toAttributes(scope, observed), output !== undefined);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = secretScope(news);
      const observed = yield* observeSecret(scope, news.name);
      if (scope.kind === "user" || observed !== undefined)
        yield* requireOwnership(output !== undefined, news.name);
      yield* putSecret(scope, news.name, Redacted.value(news.value));
      const updatedAt = yield* Effect.sync(() => new Date().toISOString());
      return { scope, name: news.name, updatedAt };
    }),
    delete: Effect.fn(function* ({ olds }) {
      yield* deleteSecret(secretScope(olds), olds.name).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
