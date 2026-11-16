import { Retry } from "@distilled.cloud/prisma";
import {
  type GetEnvironmentVariablesResponse,
  deleteEnvironmentVariable,
  getEnvironmentVariables,
  getEnvironmentVariable,
  updateEnvironmentVariable,
  createEnvironmentVariable,
} from "@distilled.cloud/prisma/management";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { DEV_TIMESTAMP, attrOrString, devId, devProvider } from "./internal/DevStub.ts";
import type { ObservedEnvironmentVariable } from "./internal/Observed.ts";
import { PrismaPaginationError } from "./internal/Pagination.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./internal/Refs.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";

export class EnvironmentVariableConflict extends Data.TaggedError("EnvironmentVariableConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class EnvironmentVariableInvalidProps extends Data.TaggedError(
  "EnvironmentVariableInvalidProps",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface EnvironmentVariableProps {
  /**
   * Project ID or `project.projectId` output that owns this variable.
   */
  project: string | Project;
  /**
   * Preview branch ID for a branch override. Omit for project-level templates.
   */
  branchId?: string;
  /**
   * Environment variable class.
   */
  class: "production" | "preview";
  /**
   * Environment variable key.
   */
  key: string;
  /**
   * Secret value. Must be wrapped with `Redacted.make(...)` so the engine
   * redacts it before resource props are persisted to state. A value that
   * resolves to `undefined`, such as an output a resource leaves unset,
   * declares no variable: one this resource wrote before is deleted.
   */
  value: Redacted.Redacted<string> | undefined;
}

export interface EnvironmentVariable extends Resource<
  "Prisma.EnvironmentVariable",
  EnvironmentVariableProps,
  {
    /**
     * Prisma environment variable ID, or null while the value is `undefined`
     * and no variable exists.
     */
    environmentVariableId: string | null;
    /**
     * Project ID that owns the variable.
     */
    projectId: string;
    /**
     * Branch ID for branch overrides, or null for project templates.
     */
    branchId: string | null;
    /**
     * Environment variable class.
     */
    class: "production" | "preview";
    /**
     * Environment variable key.
     */
    key: string;
    /**
     * Secret value, redacted in state.
     */
    value: Redacted.Redacted<string> | undefined;
    /**
     * Key identifier for the encrypted stored value.
     */
    valueKid: string | null;
    /**
     * Whether Prisma manages this variable internally.
     */
    isManagedBySystem: boolean;
    /**
     * ISO timestamp when the variable was created.
     */
    createdAt: string | null;
    /**
     * ISO timestamp when the variable was last updated.
     */
    updatedAt: string | null;
  },
  never,
  Providers
> {}

/**
 * A Prisma compute environment variable.
 *
 * Values are write-only in Prisma. Alchemy stores them as `Redacted` values
 * and reapplies the desired value to repair drift.
 *
 * ### Creating a Variable
 * **Example:** Project-level production variable
 * ```typescript
 * yield* Prisma.EnvironmentVariable("api-url", {
 *   project: project.projectId,
 *   // No branchId: this is a project-level template.
 *   class: "production",
 *   key: "API_URL",
 *   value: Redacted.make("https://api.example.com"),
 * });
 * ```
 *
 * **Example:** Preview branch override
 * ```typescript
 * yield* Prisma.EnvironmentVariable("preview-api-url", {
 *   project,
 *   branchId: preview.branchId,
 *   // Branch overrides always use the preview class.
 *   class: "preview",
 *   key: "API_URL",
 *   value: Redacted.make("https://preview.example.com"),
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const EnvironmentVariable = Resource<EnvironmentVariable>("Prisma.EnvironmentVariable");

/** The resources in this stack, other than `fqn`, that declare a variable with `key`. */
const otherDeclarers = Effect.fn(function* (fqn: string, key: string) {
  const stack = yield* Effect.serviceOption(Stack);
  if (Option.isNone(stack)) return [];
  return Object.values(stack.value.resources).flatMap((resource) =>
    resource.Type === "Prisma.EnvironmentVariable" &&
    resource.FQN !== fqn &&
    (resource.Props as Partial<EnvironmentVariableProps> | undefined)?.key === key
      ? [resource.FQN]
      : [],
  );
});

const scopeOf = (projectId: string, cls: string, branchId: string | null | undefined) =>
  `project '${projectId}', class '${cls}', ${branchId ? `Branch '${branchId}'` : "project level"}`;

/** The same key in one project and Branch scope, explained. */
const sharedKeyError = Effect.fn(function* (
  fqn: string,
  key: string,
  scope: string,
  cause?: unknown,
) {
  const others = yield* otherDeclarers(fqn, key);
  return new EnvironmentVariableConflict({
    message:
      `Prisma environment variable '${key}' already exists in ${scope}. A variable belongs to its project and Branch, not to one service: every service on that Branch reads it. ` +
      (others.length > 0
        ? `This stack declares '${key}' at '${fqn}' and also at '${others.join("', '")}', for example two Prisma.Compute that both list '${key}' in env; they would write the same variable. Declare it in one of them, or as one Prisma.EnvironmentVariable that both services read.`
        : `It appeared after the adoption check and was not written by '${fqn}'. Refusing to overwrite its secret; rerun with adoption enabled if it is the intended variable, or remove it first.`),
    cause,
  });
});

const validateEnvironmentVariableClass = (key: string, cls: unknown) =>
  cls === "production" || cls === "preview"
    ? Effect.void
    : Effect.fail(
        new EnvironmentVariableInvalidProps({
          message: `Prisma environment variable '${key}' has class '${String(cls)}'; it must be "production" or "preview". A Prisma.Compute variable takes its class from the role of its service's Branch, and that service is attached to no Branch.`,
        }),
      );

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ENV_VALUE_MAX_BYTES = 8 * 1024;

const validateEnvironmentVariableKey = (key: string) =>
  Effect.gen(function* () {
    if (key.length < 1 || key.length > 256 || !ENV_KEY_PATTERN.test(key)) {
      return yield* new EnvironmentVariableInvalidProps({
        message: `Prisma environment variable key '${key}' must match POSIX env-var key shape: [A-Z_][A-Z0-9_]* and be at most 256 characters.`,
      });
    }
  });

const validateEnvironmentVariableWrite = (key: string, value: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    yield* validateEnvironmentVariableKey(key);
    const raw = Redacted.value(value);
    if (raw.length === 0) {
      return yield* new EnvironmentVariableInvalidProps({
        message: `Prisma environment variable '${key}' value must be non-empty.`,
      });
    }
    const byteLength = yield* Effect.sync(() => new TextEncoder().encode(raw).byteLength);
    if (byteLength > ENV_VALUE_MAX_BYTES) {
      return yield* new EnvironmentVariableInvalidProps({
        message: `Prisma environment variable '${key}' value exceeds ${ENV_VALUE_MAX_BYTES} bytes.`,
      });
    }
  });

// Distilled emits the cursor-paginated list operations as plain ops, so
// callers walk `pagination` themselves (see `src/Neon/Project.ts`).
const listVariables = (
  query: {
    readonly projectId?: string;
    readonly class?: "production" | "preview";
    readonly key?: string;
    readonly branchId?: string;
    readonly limit?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const variables: GetEnvironmentVariablesResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getEnvironmentVariables(
        cursor === undefined ? query : { ...query, cursor },
      );
      variables.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* new PrismaPaginationError({
          message:
            "Invalid Prisma Management API pagination response from getEnvironmentVariables: hasMore was true without a non-empty nextCursor",
        });
      }
      cursor = nextCursor;
    }
    return variables;
  });

const findVariable = (
  projectId: string,
  cls: "production" | "preview",
  key: string,
  branchId?: string | null,
) =>
  listVariables({
    projectId,
    class: cls,
    key,
    ...(branchId ? { branchId } : {}),
    limit: 100,
  }).pipe(
    Effect.flatMap((variables) => {
      const matches = variables.filter((variable) => variable.branchId === (branchId ?? null));
      return matches.length > 1
        ? Effect.fail(
            new EnvironmentVariableConflict({
              message: `Multiple Prisma environment variables match '${key}' in the requested scope; refusing to select one arbitrarily.`,
            }),
          )
        : Effect.succeed(matches[0]);
    }),
  );

const attrsFrom = (
  variable: ObservedEnvironmentVariable,
  value: Redacted.Redacted<string>,
): EnvironmentVariable["Attributes"] => ({
  environmentVariableId: variable.id,
  projectId: variable.projectId,
  branchId: variable.branchId,
  class: variable.class,
  key: variable.key,
  value,
  valueKid: variable.valueKid,
  isManagedBySystem: variable.isManagedBySystem,
  createdAt: variable.createdAt,
  updatedAt: variable.updatedAt,
});

export class PrismaEnvironmentVariableSystemManaged extends Data.TaggedError(
  "PrismaEnvironmentVariableSystemManaged",
)<{
  readonly message: string;
}> {}

const systemManagedVariableError = (key: string) =>
  new PrismaEnvironmentVariableSystemManaged({
    message: `Prisma environment variable '${key}' is managed by Prisma and cannot be managed by Alchemy.`,
  });

const ensureUserManagedVariable = (variable: ObservedEnvironmentVariable) =>
  Effect.gen(function* () {
    if (variable.isManagedBySystem) {
      return yield* systemManagedVariableError(variable.key);
    }
  });

const ensureVariableIdentity = (
  variable: ObservedEnvironmentVariable,
  expected: {
    projectId: string;
    branchId: string | null;
    class: "production" | "preview";
    key: string;
  },
) =>
  variable.projectId === expected.projectId &&
  variable.branchId === expected.branchId &&
  variable.class === expected.class &&
  variable.key === expected.key
    ? Effect.void
    : Effect.fail(
        new EnvironmentVariableConflict({
          message: `Prisma environment variable '${variable.id}' has immutable identity project '${variable.projectId}', branch '${variable.branchId ?? "null"}', class '${variable.class}', key '${variable.key}', but this resource requires project '${expected.projectId}', branch '${expected.branchId ?? "null"}', class '${expected.class}', key '${expected.key}'. Refusing to update or delete a mismatched secret.`,
        }),
      );

/** The attributes while the value is `undefined` and no variable exists. */
const absentAttrs = (
  projectId: string,
  news: EnvironmentVariableProps,
): EnvironmentVariable["Attributes"] => ({
  environmentVariableId: null,
  projectId,
  branchId: news.branchId ?? null,
  class: news.class,
  key: news.key,
  value: undefined,
  valueKid: null,
  isManagedBySystem: false,
  createdAt: null,
  updatedAt: null,
});

const ProviderLive = () =>
  Provider.effect(
    EnvironmentVariable,
    Effect.gen(function* () {
      return {
        stables: ["environmentVariableId"],
        list: () =>
          listVariables().pipe(
            Effect.map((variables) =>
              variables
                // System-managed variables are project-owned and cannot be
                // deleted through this API.
                .filter((variable) => !variable.isManagedBySystem)
                .map((variable) =>
                  // The API deliberately never returns plaintext. `delete`
                  // needs only identity/metadata, so nuke uses an impossible
                  // empty placeholder rather than pretending to know a secret.
                  attrsFrom(variable, Redacted.make("")),
                ),
            ),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.environmentVariableId)) {
            return { action: "update" } as const;
          }
          const oldProjectId = output?.projectId ?? unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          if (
            concreteIdsChanged(oldProjectId, newProjectId) ||
            (isResolved(news.branchId) && news.branchId !== olds.branchId) ||
            (isResolved(news.class) && news.class !== olds.class) ||
            (isResolved(news.key) && news.key !== olds.key)
          ) {
            return { action: "replace" } as const;
          }
          // Values are write-only: the Management API never returns
          // plaintext, so equality with `olds` cannot prove the live secret
          // is still correct. Re-apply every resolved desired value to heal
          // out-of-band secret drift on ordinary deploys.
          if (isResolved(news.class) && isResolved(news.key)) {
            yield* validateEnvironmentVariableClass(String(news.key), news.class);
          }
          if (isResolved(news.value)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ fqn, output, olds }) {
          // No variable exists while the value is `undefined`.
          if (output?.environmentVariableId === null) return output;
          const variableId = isPrismaDevId(output?.environmentVariableId)
            ? undefined
            : output?.environmentVariableId;
          const findVariableInProject = Effect.gen(function* () {
            const projectId = unresolvedProjectIdOf(olds.project);
            return projectId
              ? yield* findVariable(projectId, olds.class, olds.key, olds.branchId)
              : undefined;
          });
          const variable = variableId
            ? yield* getEnvironmentVariable({
                envVarId: variableId,
              }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : yield* findVariableInProject;
          if (!variable) return undefined;
          if (variableId === undefined && (yield* otherDeclarers(fqn, olds.key)).length > 0) {
            return yield* yield* sharedKeyError(
              fqn,
              olds.key,
              scopeOf(variable.projectId, variable.class, variable.branchId),
            );
          }
          const attrs = attrsFrom(
            variable,
            // A cold read cannot observe the secret. Never copy the desired
            // value into output: doing so would make the forced adoption
            // reconcile falsely conclude the cloud already contains it.
            output?.value ?? Redacted.make(""),
          );
          return variableId === undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ fqn, news, output }) {
          yield* validateEnvironmentVariableClass(news.key, news.class);
          if (news.branchId !== undefined && news.class !== "preview") {
            return yield* new EnvironmentVariableInvalidProps({
              message: 'Prisma branch-scoped environment variables must use class: "preview".',
            });
          }
          yield* validateEnvironmentVariableKey(news.key);
          const projectId = yield* resolveProjectId(news.project);
          const variableId = isPrismaDevId(output?.environmentVariableId)
            ? undefined
            : output?.environmentVariableId;
          let variable = variableId
            ? yield* getEnvironmentVariable({
                envVarId: variableId,
              }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : undefined;
          const value = news.value;
          if (value === undefined) {
            // No variable: delete the one this resource wrote, if it is still there.
            if (variable) {
              yield* ensureVariableIdentity(variable, {
                projectId,
                branchId: news.branchId ?? null,
                class: news.class,
                key: news.key,
              });
              yield* ensureUserManagedVariable(variable);
              yield* deleteEnvironmentVariable({ envVarId: variable.id }).pipe(
                Effect.catchTag("NotFound", () => Effect.void),
              );
            }
            return absentAttrs(projectId, news);
          }
          yield* validateEnvironmentVariableWrite(news.key, value);
          let created = false;
          if (!variable) {
            const result = yield* createEnvironmentVariable({
              projectId,
              ...(news.branchId ? { branchId: news.branchId } : {}),
              class: news.class,
              key: news.key,
              value: Redacted.value(value),
            }).pipe(
              // A replayed create would mint a second variable; the retry
              // policy cannot see the request, so opt out explicitly.
              Retry.none,
              Effect.map((response) => ({
                variable: response.data,
                created: true,
              })),
              Effect.catchTag("Conflict", (conflict) =>
                Effect.flatMap(
                  sharedKeyError(
                    fqn,
                    news.key,
                    scopeOf(projectId, news.class, news.branchId),
                    conflict,
                  ),
                  Effect.fail,
                ),
              ),
            );
            variable = result.variable;
            created = result.created;
          }
          yield* ensureVariableIdentity(variable, {
            projectId,
            branchId: news.branchId ?? null,
            class: news.class,
            key: news.key,
          });
          yield* ensureUserManagedVariable(variable);
          if (!created) {
            variable = (yield* updateEnvironmentVariable({
              envVarId: variable.id,
              value: Redacted.value(value),
            })).data;
          }
          return attrsFrom(variable, value);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          if (output.environmentVariableId === null) return;
          if (isPrismaDevId(output.environmentVariableId)) return;
          const variable = yield* getEnvironmentVariable({
            envVarId: output.environmentVariableId,
          }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
          if (!variable) return;
          yield* ensureVariableIdentity(variable, {
            projectId: output.projectId,
            branchId: output.branchId,
            class: output.class,
            key: output.key,
          });
          if (variable.isManagedBySystem) {
            // Prisma-owned environment variables are provider-managed system
            // state and are not deletable through this resource lifecycle.
            if (session !== undefined) {
              yield* session.note(
                `Skipping direct delete for system-managed Prisma environment variable '${variable.key}'.`,
              );
            }
            return;
          }
          yield* deleteEnvironmentVariable({
            envVarId: variable.id,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(EnvironmentVariable, ["environmentVariableId"], ({ id, news }) => ({
    environmentVariableId: devId("environment-variable", id),
    projectId: attrOrString(news.project, "projectId"),
    branchId: news.branchId ?? null,
    class: news.class,
    key: news.key,
    value: news.value,
    valueKid: devId("value-kid", id),
    isManagedBySystem: false,
    createdAt: DEV_TIMESTAMP,
    updatedAt: DEV_TIMESTAMP,
  }));

export const EnvironmentVariableProvider = () =>
  ProviderLayer.dual(EnvironmentVariable, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
