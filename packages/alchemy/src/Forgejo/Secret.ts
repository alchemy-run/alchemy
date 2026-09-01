import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  ForgejoCredentials,
  ignoreInaccessible,
  optional,
  paginate,
} from "./Client.ts";
import {
  listAccessibleOrganizations,
  listAccessibleRepositories,
} from "./Lists.ts";
import type * as Forgejo from "./Providers.ts";

/**
 * Repository scope for an Actions secret or variable.
 */
export interface RepositoryActionsScope {
  /**
   * Scope discriminator.
   */
  readonly kind: "repository";
  /**
   * Repository owner.
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly repository: string;
}

/**
 * Organization scope for an Actions secret or variable.
 */
export interface OrganizationActionsScope {
  /**
   * Scope discriminator.
   */
  readonly kind: "organization";
  /**
   * Organization login.
   */
  readonly organization: string;
}

/**
 * Authenticated-user scope for an Actions secret or variable.
 */
export interface UserActionsScope {
  /**
   * Scope discriminator.
   */
  readonly kind: "user";
}

/**
 * Actions configuration scope.
 */
export type ActionsScope =
  | RepositoryActionsScope
  | OrganizationActionsScope
  | UserActionsScope;
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
   * Timestamp of reconciliation.
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
 * never be read back, so every deploy writes it.
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
 * yield* Forgejo.Secret("npm", {
 *   scope: { kind: "user" },
 *   name: "NPM_TOKEN",
 *   value: Redacted.make(process.env.NPM_TOKEN!),
 * });
 * ```
 *
 * @resource
 */
export const Secret = Resource<Secret>("Forgejo.Secret");
/**
 * Resolve legacy and scoped secret properties into one scope.
 */
export const secretScope = (props: SecretProps): ActionsScope =>
  "scope" in props
    ? props.scope
    : { kind: "repository", owner: props.owner, repository: props.repository };
/**
 * Structural equality for two Actions scopes.
 *
 * Comparing serialized scopes instead would be key-order sensitive, so
 * migrating a resource from the legacy repository props to the equivalent
 * explicit `scope` would plan a needless replacement — and replacing a secret
 * deletes it before recreating it, leaving CI without the value in between.
 */
export const sameScope = (a: ActionsScope, b: ActionsScope): boolean => {
  if (a.kind === "repository" && b.kind === "repository")
    return a.owner === b.owner && a.repository === b.repository;
  if (a.kind === "organization" && b.kind === "organization")
    return a.organization === b.organization;
  return a.kind === "user" && b.kind === "user";
};
const path = (props: SecretProps) => {
  const scope = secretScope(props);
  const suffix = `/${encodeURIComponent(props.name)}`;
  if (scope.kind === "repository")
    return `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repository)}/actions/secrets${suffix}`;
  if (scope.kind === "organization")
    return `/orgs/${encodeURIComponent(scope.organization)}/actions/secrets${suffix}`;
  return `/user/actions/secrets${suffix}`;
};
/**
 * Secret representation returned by the Forgejo Actions API. Values are never
 * readable back, so only identity and timestamps are exposed.
 */
interface ApiSecret {
  readonly name: string;
  readonly created_at?: string;
}

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
    list: Effect.fn(function* () {
      const client = yield* ForgejoCredentials;
      const repositories = yield* listAccessibleRepositories();
      const organizations = yield* listAccessibleOrganizations();

      // Enumeration spans everything the credential can see; a repository or
      // organization whose Actions settings are not readable is skipped
      // rather than failing the whole sweep.
      const repositorySecrets = yield* Effect.forEach(
        repositories,
        (repository) =>
          ignoreInaccessible(
            paginate<ApiSecret>(
              client,
              `/repos/${encodeURIComponent(repository.owner.login)}/${encodeURIComponent(repository.name)}/actions/secrets`,
            ),
            [] as readonly ApiSecret[],
          ).pipe(
            Effect.map((secrets) =>
              secrets.map((secret) => ({
                scope: {
                  kind: "repository" as const,
                  owner: repository.owner.login,
                  repository: repository.name,
                },
                name: secret.name,
                updatedAt: secret.created_at ?? "",
              })),
            ),
          ),
        { concurrency: 8 },
      );

      const organizationSecrets = yield* Effect.forEach(
        organizations,
        (organization) =>
          ignoreInaccessible(
            paginate<ApiSecret>(
              client,
              `/orgs/${encodeURIComponent(organization.username)}/actions/secrets`,
            ),
            [] as readonly ApiSecret[],
          ).pipe(
            Effect.map((secrets) =>
              secrets.map((secret) => ({
                scope: {
                  kind: "organization" as const,
                  organization: organization.username,
                },
                name: secret.name,
                updatedAt: secret.created_at ?? "",
              })),
            ),
          ),
        { concurrency: 8 },
      );

      // User-scoped secrets are deliberately absent: Forgejo exposes
      // `/user/actions/secrets/{name}` for PUT and DELETE but has no
      // collection endpoint to enumerate them, unlike the repository,
      // organization, and user-variable collections. Requesting one would
      // 404 on every sweep and be silently swallowed, which reads as if it
      // worked. A user-scoped secret therefore has to be destroyed through
      // the stack that declared it.
      return [...repositorySecrets.flat(), ...organizationSecrets.flat()];
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const client = yield* ForgejoCredentials;
      // Forgejo's secret endpoint is an upsert and the stored value can never
      // be read back, so there is nothing to observe or diff against.
      yield* client.request<void>("PUT", path(news), {
        body: { data: Redacted.value(news.value) },
      });
      const updatedAt = yield* Effect.sync(() => new Date().toISOString());
      return { scope: secretScope(news), name: news.name, updatedAt };
    }),
    delete: Effect.fn(function* ({ olds }) {
      const client = yield* ForgejoCredentials;
      yield* optional(client.request<void>("DELETE", path(olds)));
    }),
  });
