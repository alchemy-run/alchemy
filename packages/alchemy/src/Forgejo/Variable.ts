import { Services } from "@distilled.cloud/forgejo";
import type { ActionVariable as ApiVariable } from "@distilled.cloud/forgejo/repository";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  listAccessibleOrganizations,
  listAccessibleRepositories,
} from "./Lists.ts";
import { paginate } from "./Pagination.ts";
import type * as Forgejo from "./Providers.ts";
import { type ActionsScope, sameScope } from "./Secret.ts";

/**
 * Legacy repository-scoped variable properties.
 */
export interface LegacyVariableProps {
  /**
   * Repository owner.
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly repository: string;
  /**
   * Variable name.
   */
  readonly name: string;
  /**
   * Plain-text value.
   */
  readonly value: string;
}

/**
 * Desired Forgejo Actions variable properties.
 */
export type VariableProps =
  | LegacyVariableProps
  | {
      /**
       * Scope of this variable.
       */
      readonly scope: ActionsScope;
      /**
       * Variable name.
       */
      readonly name: string;
      /**
       * Plain-text value.
       */
      readonly value: string;
    };
/**
 * Observed Forgejo Actions variable attributes.
 */
export interface VariableAttributes {
  /**
   * Scope of the variable.
   */
  readonly scope: ActionsScope;
  /**
   * Variable name.
   */
  readonly name: string;
  /**
   * Plain-text value.
   */
  readonly value: string;
}

/**
 * A Forgejo Actions variable resource.
 */
export interface Variable extends Resource<
  "Forgejo.Variable",
  VariableProps,
  VariableAttributes,
  never,
  Forgejo.Providers
> {}
/**
 * A Forgejo Actions variable, scoped to a repository, an organization, or the
 * authenticated user.
 *
 * Variables hold plain text and are readable back, so a deploy whose value
 * already matches issues no write.
 *
 * ### Creating a Variable
 * **Example:** Repository Variable
 * ```typescript
 * yield* Forgejo.Variable("stage", {
 *   owner: "acme",
 *   repository: "api",
 *   name: "DEPLOY_STAGE",
 *   value: "production",
 * });
 * ```
 *
 * ### Scoping a Variable
 * **Example:** Organization Variable
 * ```typescript
 * yield* Forgejo.Variable("registry", {
 *   scope: { kind: "organization", organization: "acme" },
 *   name: "REGISTRY_HOST",
 *   value: "registry.acme.example",
 * });
 * ```
 *
 * @resource
 */
export const Variable = Resource<Variable>("Forgejo.Variable");
/**
 * Resolve legacy and scoped variable properties into one scope.
 */
export const variableScope = (props: VariableProps): ActionsScope =>
  "scope" in props
    ? props.scope
    : { kind: "repository", owner: props.owner, repository: props.repository };

/**
 * Forgejo has one variable endpoint family per scope, so each lifecycle step
 * dispatches on the scope kind.
 */
const getVariable = Effect.fn(function* (scope: ActionsScope, name: string) {
  if (scope.kind === "repository") {
    return yield* Services.repository.getRepoVariable({
      owner: scope.owner,
      repo: scope.repository,
      variablename: name,
    });
  }
  if (scope.kind === "organization") {
    return yield* Services.organization.getOrgVariable({
      org: scope.organization,
      variablename: name,
    });
  }
  return yield* Services.user.getUserVariable({ variablename: name });
});

const createVariable = Effect.fn(function* (
  scope: ActionsScope,
  name: string,
  value: string,
) {
  if (scope.kind === "repository") {
    return yield* Services.repository.createRepoVariable({
      owner: scope.owner,
      repo: scope.repository,
      variablename: name,
      value,
    });
  }
  if (scope.kind === "organization") {
    return yield* Services.organization.createOrgVariable({
      org: scope.organization,
      variablename: name,
      value,
    });
  }
  return yield* Services.user.createUserVariable({
    variablename: name,
    value,
  });
});

const updateVariable = Effect.fn(function* (
  scope: ActionsScope,
  name: string,
  value: string,
) {
  if (scope.kind === "repository") {
    return yield* Services.repository.updateRepoVariable({
      owner: scope.owner,
      repo: scope.repository,
      variablename: name,
      value,
    });
  }
  if (scope.kind === "organization") {
    return yield* Services.organization.updateOrgVariable({
      org: scope.organization,
      variablename: name,
      value,
    });
  }
  return yield* Services.user.updateUserVariable({
    variablename: name,
    value,
  });
});

const deleteVariable = Effect.fn(function* (scope: ActionsScope, name: string) {
  if (scope.kind === "repository") {
    return yield* Services.repository.deleteRepoVariable({
      owner: scope.owner,
      repo: scope.repository,
      variablename: name,
    });
  }
  if (scope.kind === "organization") {
    return yield* Services.organization.deleteOrgVariable({
      org: scope.organization,
      variablename: name,
    });
  }
  return yield* Services.user.deleteUserVariable({ variablename: name });
});

/**
 * Forgejo returns the value under `data`, not `value` — the field name
 * differs from the one accepted on write.
 */
const toAttributes = (
  scope: ActionsScope,
  variable: ApiVariable,
): VariableAttributes => ({
  scope,
  name: variable.name,
  value: variable.data,
});

/**
 * Provider layer implementing Actions-variable lifecycle.
 */
export const VariableProvider = () =>
  Provider.succeed(Variable, {
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (!sameScope(variableScope(news), variableScope(olds)) ||
            news.name !== olds.name)
          ? { action: "replace" as const }
          : undefined,
      ),
    list: Effect.fn(function* () {
      const repositories = yield* listAccessibleRepositories();
      const organizations = yield* listAccessibleOrganizations();

      // Enumeration spans everything the credential can see; a repository or
      // organization whose Actions settings are not readable is skipped
      // rather than failing the whole sweep.
      const repositoryVariables = yield* Effect.forEach(
        repositories,
        (repository) => {
          const scope: ActionsScope = {
            kind: "repository",
            owner: repository.owner.login,
            repository: repository.name,
          };
          return paginate(Services.repository.getRepoVariablesList, {
            owner: repository.owner.login,
            repo: repository.name,
          }).pipe(
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed([]),
            ),
            Effect.map((variables) =>
              variables.map((variable) => toAttributes(scope, variable)),
            ),
          );
        },
        { concurrency: 8 },
      );

      const organizationVariables = yield* Effect.forEach(
        organizations,
        (organization) => {
          const scope: ActionsScope = {
            kind: "organization",
            organization: organization.username,
          };
          return paginate(Services.organization.getOrgVariablesList, {
            org: organization.username,
          }).pipe(
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed([]),
            ),
            Effect.map((variables) =>
              variables.map((variable) => toAttributes(scope, variable)),
            ),
          );
        },
        { concurrency: 8 },
      );

      const userScope: ActionsScope = { kind: "user" };
      const userVariables = yield* paginate(
        Services.user.getUserVariablesList,
        {},
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([])),
        Effect.map((variables) =>
          variables.map((variable) => toAttributes(userScope, variable)),
        ),
      );

      return [
        ...repositoryVariables.flat(),
        ...organizationVariables.flat(),
        ...userVariables,
      ];
    }),
    read: Effect.fn(function* ({ olds }) {
      const scope = variableScope(olds);
      const observed = yield* getVariable(scope, olds.name).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      return observed === undefined ? undefined : toAttributes(scope, observed);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const scope = variableScope(news);
      const observed = yield* getVariable(scope, news.name).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );

      if (observed === undefined) {
        yield* createVariable(scope, news.name, news.value);
      } else if (observed.data !== news.value) {
        yield* updateVariable(scope, news.name, news.value);
      }

      return { scope, name: news.name, value: news.value };
    }),
    delete: Effect.fn(function* ({ olds }) {
      yield* deleteVariable(variableScope(olds), olds.name).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
