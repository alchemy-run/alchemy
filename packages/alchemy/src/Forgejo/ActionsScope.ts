/**
 * The Actions scope model shared by the Forgejo secret and variable
 * resources, plus the account-wide sweep both enumerate through.
 *
 * Not exported from `index.ts` — this is internal scaffolding. The parts that
 * form the public props surface are re-exported from `Secret.ts`, and only
 * from there, so the star exports in `index.ts` cannot collide.
 */

import * as Effect from "effect/Effect";
import {
  listAccessibleOrganizations,
  listAccessibleRepositories,
} from "./Lists.ts";

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
 * The two prop shapes every Actions resource accepts: the legacy
 * repository-scoped pair, or an explicit scope.
 */
export type ScopedProps =
  | { readonly scope: ActionsScope }
  | { readonly owner: string; readonly repository: string };

/**
 * Resolve legacy and scoped properties into one scope.
 */
export const actionsScope = (props: ScopedProps): ActionsScope =>
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

/**
 * Collect the Actions entries of every repository and organization the
 * credential can see, tagged with the scope they were found in.
 *
 * Enumeration spans everything the credential can see; a repository or
 * organization whose Actions settings are not readable is skipped rather
 * than failing the whole sweep. That tolerance lives in the `repository` and
 * `organization` listers passed in, not here, because catching `NotFound` /
 * `Forbidden` needs the operation's concrete typed error union — a generic
 * `E` has no tags for `Effect.catchTag` to match.
 *
 * User-scoped entries are deliberately absent: only the caller knows whether
 * its endpoint family has a user-level collection to enumerate.
 */
export const listActionsEntries = <Entry, Attributes, E, R>(options: {
  /**
   * Entries of one repository, with unreadable repositories yielding none.
   */
  readonly repository: (
    scope: RepositoryActionsScope,
  ) => Effect.Effect<readonly Entry[], E, R>;
  /**
   * Entries of one organization, with unreadable organizations yielding none.
   */
  readonly organization: (
    scope: OrganizationActionsScope,
  ) => Effect.Effect<readonly Entry[], E, R>;
  /**
   * Map one API entry and the scope it was found in onto resource attributes.
   */
  readonly toAttributes: (scope: ActionsScope, entry: Entry) => Attributes;
}) =>
  Effect.gen(function* () {
    const repositories = yield* listAccessibleRepositories();
    const organizations = yield* listAccessibleOrganizations();

    const repositoryEntries = yield* Effect.forEach(
      repositories,
      (repository) => {
        const scope: RepositoryActionsScope = {
          kind: "repository",
          owner: repository.owner.login,
          repository: repository.name,
        };
        return options
          .repository(scope)
          .pipe(
            Effect.map((entries) =>
              entries.map((entry) => options.toAttributes(scope, entry)),
            ),
          );
      },
      { concurrency: 8 },
    );

    const organizationEntries = yield* Effect.forEach(
      organizations,
      (organization) => {
        const scope: OrganizationActionsScope = {
          kind: "organization",
          organization: organization.username,
        };
        return options
          .organization(scope)
          .pipe(
            Effect.map((entries) =>
              entries.map((entry) => options.toAttributes(scope, entry)),
            ),
          );
      },
      { concurrency: 8 },
    );

    return [...repositoryEntries.flat(), ...organizationEntries.flat()];
  });
