import * as Effect from "effect/Effect";
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
import type { ActionsScope } from "./Secret.ts";

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
const path = (props: VariableProps) => {
  const scope = variableScope(props);
  const suffix = `/${encodeURIComponent(props.name)}`;
  if (scope.kind === "repository")
    return `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repository)}/actions/variables${suffix}`;
  if (scope.kind === "organization")
    return `/orgs/${encodeURIComponent(scope.organization)}/actions/variables${suffix}`;
  return `/user/actions/variables${suffix}`;
};
/**
 * Variable representation returned by the Forgejo Actions API.
 *
 * Forgejo returns the value under `data`, not `value` — the field name
 * differs from the one accepted on write.
 */
interface ApiVariable {
  readonly name: string;
  readonly data: string;
}

/**
 * Provider layer implementing Actions-variable lifecycle.
 */
export const VariableProvider = () =>
  Provider.succeed(Variable, {
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (JSON.stringify(variableScope(news)) !==
            JSON.stringify(variableScope(olds)) ||
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
      const repositoryVariables = yield* Effect.forEach(
        repositories,
        (repository) =>
          ignoreInaccessible(
            paginate<ApiVariable>(
              client,
              `/repos/${encodeURIComponent(repository.owner.login)}/${encodeURIComponent(repository.name)}/actions/variables`,
            ),
            [] as readonly ApiVariable[],
          ).pipe(
            Effect.map((variables) =>
              variables.map((variable) => ({
                scope: {
                  kind: "repository" as const,
                  owner: repository.owner.login,
                  repository: repository.name,
                },
                name: variable.name,
                value: variable.data,
              })),
            ),
          ),
        { concurrency: 8 },
      );

      const organizationVariables = yield* Effect.forEach(
        organizations,
        (organization) =>
          ignoreInaccessible(
            paginate<ApiVariable>(
              client,
              `/orgs/${encodeURIComponent(organization.username)}/actions/variables`,
            ),
            [] as readonly ApiVariable[],
          ).pipe(
            Effect.map((variables) =>
              variables.map((variable) => ({
                scope: {
                  kind: "organization" as const,
                  organization: organization.username,
                },
                name: variable.name,
                value: variable.data,
              })),
            ),
          ),
        { concurrency: 8 },
      );

      const userVariables = yield* ignoreInaccessible(
        paginate<ApiVariable>(client, "/user/actions/variables"),
        [] as readonly ApiVariable[],
      );

      return [
        ...repositoryVariables.flat(),
        ...organizationVariables.flat(),
        ...userVariables.map((variable) => ({
          scope: { kind: "user" as const },
          name: variable.name,
          value: variable.data,
        })),
      ];
    }),
    read: Effect.fn(function* ({ olds }) {
      const client = yield* ForgejoCredentials;
      const observed = yield* optional(
        client.request<ApiVariable>("GET", path(olds)),
      );
      return observed === undefined
        ? undefined
        : {
            scope: variableScope(olds),
            name: observed.name,
            value: observed.data,
          };
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const client = yield* ForgejoCredentials;
      const observed = yield* optional(
        client.request<ApiVariable>("GET", path(news)),
      );

      if (observed === undefined) {
        yield* client.request<void>("POST", path(news), {
          body: { value: news.value },
        });
      } else if (observed.data !== news.value) {
        yield* client.request<void>("PUT", path(news), {
          body: { value: news.value },
        });
      }

      return {
        scope: variableScope(news),
        name: news.name,
        value: news.value,
      };
    }),
    delete: Effect.fn(function* ({ olds }) {
      const client = yield* ForgejoCredentials;
      yield* optional(client.request<void>("DELETE", path(olds)));
    }),
  });
