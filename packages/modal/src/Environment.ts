import * as environment from "@distilled.cloud/modal/environment";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isGeneratedName, objectName } from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";

export class EnvironmentUnexpectedResponse extends Data.TaggedError(
  "Modal.EnvironmentUnexpectedResponse",
)<{
  readonly message: string;
}> {}

/** A member's access to an environment. */
export type EnvironmentRole = "viewer" | "contributor" | "no-access";

const ROLE_TO_WIRE = {
  viewer: "ENVIRONMENT_ROLE_VIEWER",
  contributor: "ENVIRONMENT_ROLE_CONTRIBUTOR",
  "no-access": "ENVIRONMENT_ROLE_NO_ACCESS",
} as const satisfies Record<EnvironmentRole, environment.EnvironmentRole>;

const roleFromWire = (role: string | undefined): EnvironmentRole | undefined =>
  (Object.keys(ROLE_TO_WIRE) as EnvironmentRole[]).find((key) => ROLE_TO_WIRE[key] === role);

/** One role assignment: a workspace member or service user, and its role. */
export type EnvironmentRoleAssignment =
  | { readonly userId: string; readonly role: EnvironmentRole }
  | { readonly serviceUserId: string; readonly role: EnvironmentRole };

export interface EnvironmentProps {
  /**
   * Environment name, unique in the workspace. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it renames the
   * environment in place.
   */
  name?: string;
  /**
   * Suffix of web endpoint URLs in this environment
   * (`<workspace>-<suffix>--<app>.modal.run`).
   * @default the environment name
   */
  webhookSuffix?: string;
  /** Most tasks (containers) running at once in this environment. */
  maxConcurrentTasks?: number;
  /** Most GPUs in use at once in this environment. */
  maxConcurrentGpus?: number;
  /**
   * Monthly spend limit in US dollars for this environment. Removing it
   * clears the limit. Budgets need a Modal plan that includes them;
   * elsewhere the deploy fails with `EnvironmentBudgetsNotEnabled`.
   */
  budget?: number;
  /**
   * Require authentication for web endpoints and tunnels in this
   * environment: `true` blocks unauthenticated traffic, `false` allows it,
   * and `undefined` inherits the workspace default.
   */
  blockUnauthenticatedResources?: boolean;
  /**
   * Restrict the environment to explicit members (a managed environment).
   * Members without an assignment in {@link roles} get
   * {@link defaultMemberRole}.
   * @default false
   */
  managed?: boolean;
  /**
   * Role every workspace member gets in a managed environment unless
   * {@link roles} assigns one.
   */
  defaultMemberRole?: EnvironmentRole;
  /**
   * Explicit role assignments. Each listed principal gets its role; a
   * principal that was assigned before and is no longer listed falls back
   * to {@link defaultMemberRole}.
   */
  roles?: EnvironmentRoleAssignment[];
}

export interface EnvironmentAttributes {
  /** Environment ID (`en-…`). */
  environmentId: string;
  /** Environment name. */
  name: string;
  /** Suffix of web endpoint URLs in this environment. */
  webhookSuffix: string | undefined;
  /** Whether this is the workspace's default environment. */
  isDefault: boolean;
  /** Whether membership is restricted (a managed environment). */
  managed: boolean;
}

/**
 * A Modal Environment: an isolated namespace inside a workspace for Apps,
 * Volumes, Dicts, Queues, Secrets and Sandboxes, with its own concurrency
 * limits, spend budget and member roles. Objects with the same name in two
 * environments are different objects, so one environment per stage keeps
 * stages apart.
 *
 * Modal environments have no tags. Ownership is inferred from Alchemy
 * state: an environment found under an explicit `name` without prior state
 * is reported as unowned.
 *
 * ### Creating an Environment
 * **Example:** One environment per stage
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Agents = Modal.Environment("Agents", {});
 * ```
 *
 * **Example:** Limits and a monthly budget
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Agents = Modal.Environment("Agents", {
 *   maxConcurrentTasks: 50,
 *   maxConcurrentGpus: 4,
 *   budget: 200,
 * });
 * ```
 *
 * ### Access control
 * **Example:** A managed environment with explicit roles
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Production = Modal.Environment("Production", {
 *   name: "production",
 *   managed: true,
 *   defaultMemberRole: "viewer",
 *   roles: [{ userId: "us-1234", role: "contributor" }],
 *   blockUnauthenticatedResources: true,
 * });
 * ```
 *
 * ### Using the environment
 * **Example:** Put objects in it
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Agents = Modal.Environment("Agents", {});
 * export const Coder = Modal.App("Coder", { environment: Agents });
 * export const Workspace = Modal.Volume("Workspace", { environment: Agents });
 * ```
 *
 * ### Looking up an existing environment
 * `Environment.lookup` references an environment Alchemy doesn't manage (created with
 * the Modal CLI or by another stack). It is read during plan/deploy, never
 * created, updated or deleted.
 *
 * **Example:** Reference an existing environment
 * ```typescript
 * const staging = Modal.Environment.lookup({ name: "staging" });
 * ```
 *
 * @resource
 * @product Environment
 */
export const Environment = declarable<Environment>()(Resource<Environment>("Modal.Environment"));

export type Environment = Resource<
  "Modal.Environment",
  EnvironmentProps,
  EnvironmentAttributes,
  never,
  Providers,
  EnvironmentLookup
>;

/**
 * Props for {@link Environment.lookup}: find an environment this
 * stack doesn't manage by its name.
 */
export interface EnvironmentLookup {
  /** Environment name. */
  name: string;
}

const blockToWire = (
  value: boolean | undefined,
): environment.EnvironmentBlockUnauthenticatedResources =>
  value === undefined
    ? "ENVIRONMENT_BLOCK_UNAUTHENTICATED_RESOURCES_INHERIT"
    : value
      ? "ENVIRONMENT_BLOCK_UNAUTHENTICATED_RESOURCES_BLOCK"
      : "ENVIRONMENT_BLOCK_UNAUTHENTICATED_RESOURCES_ALLOW";

const principalKey = (p: { userId?: string; serviceUserId?: string }) =>
  p.userId ? `user:${p.userId}` : `service:${p.serviceUserId ?? ""}`;

export const EnvironmentProvider = () =>
  Provider.effect(
    Environment,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (name: string) {
        const { items } = yield* environment.listEnvironment({});
        return (items ?? []).find((item) => item.name === name);
      });

      const toAttrs = (item: environment.EnvironmentListItem): EnvironmentAttributes => ({
        environmentId: item.environmentId ?? "",
        name: item.name ?? "",
        webhookSuffix: item.webhookSuffix || undefined,
        isDefault: item.default ?? false,
        managed: item.isManaged ?? false,
      });

      return {
        stables: ["environmentId"],
        lookup: Effect.fn(function* ({ name }) {
          const item = yield* observe(name);
          return item ? toAttrs(item) : undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* objectName(id, olds?.name));
          const item = yield* observe(name);
          if (!item) return undefined;
          const attrs = toAttrs(item);
          return output !== undefined || olds?.name === undefined ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredName = yield* objectName(id, news.name);

          // Observe: by the previous name (a rename) and the desired name.
          let current =
            (output !== undefined && output.name !== desiredName
              ? yield* observe(output.name)
              : undefined) ?? (yield* observe(desiredName));

          // Ensure
          if (!current) {
            yield* session.note(`Creating environment ${desiredName}...`);
            yield* environment
              .createEnvironment({
                name: desiredName,
                isManaged: news.managed,
                defaultMemberRole: news.defaultMemberRole
                  ? ROLE_TO_WIRE[news.defaultMemberRole]
                  : undefined,
              })
              .pipe(Effect.catchTag("EnvironmentAlreadyExists", () => Effect.void));
            current = yield* observe(desiredName);
            if (!current) {
              return yield* new EnvironmentUnexpectedResponse({
                message: `Modal environment ${desiredName} was not listed after create`,
              });
            }
          }

          // Sync name, suffix, limits and the unauthenticated-resources policy.
          const desiredBlock = blockToWire(news.blockUnauthenticatedResources);
          const observedBlock = blockToWire(current.blockUnauthenticatedResources);
          if (
            current.name !== desiredName ||
            (news.webhookSuffix !== undefined && current.webhookSuffix !== news.webhookSuffix) ||
            (news.maxConcurrentTasks !== undefined &&
              current.maxConcurrentTasks !== news.maxConcurrentTasks) ||
            (news.maxConcurrentGpus !== undefined &&
              current.maxConcurrentGpus !== news.maxConcurrentGpus) ||
            (news.blockUnauthenticatedResources !== undefined && desiredBlock !== observedBlock)
          ) {
            yield* environment.updateEnvironment({
              currentName: current.name,
              name: desiredName,
              webSuffix: news.webhookSuffix,
              maxConcurrentTasks: news.maxConcurrentTasks,
              maxConcurrentGpus: news.maxConcurrentGpus,
              blockUnauthenticatedResources:
                news.blockUnauthenticatedResources === undefined ? undefined : desiredBlock,
            });
          }
          const environmentId = current.environmentId ?? "";

          // Sync budget against the observed limit. A workspace without
          // budgets has none to clear; asking for one there fails with
          // `EnvironmentBudgetsNotEnabled`.
          const budget = yield* environment
            .environmentGetBudget({ environmentId })
            .pipe(
              Effect.catchTag("EnvironmentBudgetsNotEnabled", () =>
                Effect.succeed<Partial<environment.EnvironmentGetBudgetResponse>>({}),
              ),
            );
          if (news.budget !== undefined && budget.cycleBudgetDollars !== news.budget) {
            yield* environment.environmentSetBudget({
              environmentId,
              cycleBudgetDollars: news.budget,
            });
          } else if (news.budget === undefined && budget.cycleBudgetDollars !== undefined) {
            yield* environment.environmentSetBudget({ environmentId, clearBudget: true });
          }

          // Sync managed mode and the default member role.
          const managed = news.managed ?? false;
          if ((current.isManaged ?? false) !== managed) {
            yield* environment.environmentSetManaged({
              environmentId,
              managed,
              defaultMemberRole: news.defaultMemberRole
                ? ROLE_TO_WIRE[news.defaultMemberRole]
                : undefined,
            });
          }
          if (
            news.defaultMemberRole !== undefined &&
            roleFromWire(current.defaultMemberRole) !== news.defaultMemberRole
          ) {
            yield* environment.environmentSetDefaultMemberRole({
              environmentId,
              defaultMemberRole: ROLE_TO_WIRE[news.defaultMemberRole],
            });
          }

          // Sync explicit role assignments against the observed principals:
          // listed principals get their role, and any other principal with
          // an explicit assignment falls back to the default member role.
          if (news.roles !== undefined) {
            const observed = yield* environment.environmentGetRoles({ environmentId });
            const principals = observed.principalRoles ?? [];
            const desired = new Map(
              news.roles.map((assignment) => [principalKey(assignment), assignment]),
            );
            for (const assignment of desired.values()) {
              const match = principals.find((p) => principalKey(p) === principalKey(assignment));
              if (
                match === undefined ||
                match.hasRoleAssignment !== true ||
                roleFromWire(match.role) !== assignment.role
              ) {
                yield* environment.setEnvironmentRole({
                  environmentId,
                  ...("userId" in assignment
                    ? { userId: assignment.userId }
                    : { serviceUserId: assignment.serviceUserId }),
                  role: ROLE_TO_WIRE[assignment.role],
                });
              }
            }
            for (const principal of principals) {
              if (principal.hasRoleAssignment !== true || desired.has(principalKey(principal))) {
                continue;
              }
              yield* environment.setEnvironmentRole({
                environmentId,
                userId: principal.userId || undefined,
                serviceUserId: principal.serviceUserId || undefined,
                role: "ENVIRONMENT_ROLE_UNSPECIFIED",
              });
            }
          }

          const final = yield* observe(desiredName);
          return toAttrs(final ?? current);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* environment
            .deleteEnvironment({ name: output.name })
            .pipe(Effect.catchTag("EnvironmentNotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const { items } = yield* environment.listEnvironment({});
          return (items ?? [])
            .filter((item) => !item.default && isGeneratedName(item.name))
            .map(toAttrs);
        }),
      };
    }),
  );
