import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Redacted from "effect/Redacted";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  PrismaClient,
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import { validateEnvironmentVariableWrite } from "./EnvironmentVariableValidation.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type { EnvironmentVariable as ApiEnvironmentVariable } from "./Types.ts";

export interface EnvironmentVariableProps {
  /**
   * Project ID or `project.projectId` output that owns this variable.
   */
  project: string | Project;
  /**
   * Environment variable class.
   */
  class: "production" | "preview";
  /**
   * Environment variable key.
   */
  key: string;
  /**
   * Secret value. Use Redacted.make for state-safe redaction.
   */
  value: string | Redacted.Redacted<string>;
}

export interface EnvironmentVariable extends Resource<
  "Prisma.EnvironmentVariable",
  EnvironmentVariableProps,
  {
    /**
     * Prisma environment variable ID.
     */
    environmentVariableId: string;
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
    value: Redacted.Redacted<string>;
    /**
     * Key identifier for the encrypted stored value.
     */
    valueKid: string;
    /**
     * Whether Prisma manages this variable internally.
     */
    isManagedBySystem: boolean;
    /**
     * ISO timestamp when the variable was created.
     */
    createdAt: string;
    /**
     * ISO timestamp when the variable was last updated.
     */
    updatedAt: string;
  },
  never,
  Providers
> {}

/**
 * A Prisma compute environment variable.
 *
 * @section Creating a Variable
 * @example Production secret
 * ```typescript
 * yield* Prisma.EnvironmentVariable("database-url", {
 *   project: project.projectId,
 *   class: "production",
 *   key: "DATABASE_URL",
 *   value: Redacted.make("postgres://..."),
 * });
 * ```
 */
export const EnvironmentVariable = Resource<EnvironmentVariable>(
  "Prisma.EnvironmentVariable",
);

const valueOf = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const redacted = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

const findVariable = (
  client: PrismaManagementClient,
  projectId: string,
  cls: "production" | "preview",
  key: string,
) =>
  client
    .listEnvironmentVariables({ projectId, class: cls, key, limit: 2 })
    .pipe(
      Effect.map((variables) =>
        variables.find((variable) => variable.branchId === null),
      ),
    );

const attrsFrom = (
  variable: ApiEnvironmentVariable,
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

export const EnvironmentVariableProvider = () =>
  Provider.effect(
    EnvironmentVariable,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["environmentVariableId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (isPrismaDevId(output?.environmentVariableId)) {
            return { action: "update" } as const;
          }
          const oldProjectId = unresolvedProjectIdOf(olds.project);
          const newProjectId = unresolvedProjectIdOf(news.project);
          if (oldProjectId === undefined || newProjectId === undefined) {
            return undefined;
          }
          if (
            newProjectId !== oldProjectId ||
            news.class !== olds.class ||
            news.key !== olds.key
          ) {
            return { action: "replace" } as const;
          }
          if (valueOf(news.value) !== valueOf(olds.value)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const variableId = isPrismaDevId(output?.environmentVariableId)
            ? undefined
            : output?.environmentVariableId;
          const variable = variableId
            ? yield* client
                .getEnvironmentVariable(variableId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId
                  ? yield* findVariable(client, projectId, olds.class, olds.key)
                  : undefined;
              });
          return variable
            ? attrsFrom(variable, output?.value ?? redacted(olds.value))
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          yield* validateEnvironmentVariableWrite(news.key, news.value);
          const projectId = yield* resolveProjectId(news.project);
          const variableId = isPrismaDevId(output?.environmentVariableId)
            ? undefined
            : output?.environmentVariableId;
          let variable = variableId
            ? yield* client
                .getEnvironmentVariable(variableId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findVariable(client, projectId, news.class, news.key);
          const value = redacted(news.value);
          let created = false;
          if (!variable) {
            const result = yield* client
              .createEnvironmentVariable({
                projectId,
                class: news.class,
                key: news.key,
                value: Redacted.value(value),
              })
              .pipe(
                Effect.map((variable) => ({ variable, created: true })),
                Effect.catchIf(isConflict, () =>
                  findVariable(client, projectId, news.class, news.key).pipe(
                    Effect.flatMap((variable) =>
                      variable
                        ? Effect.succeed({ variable, created: false })
                        : Effect.fail(
                            new Error(
                              `Prisma environment variable '${news.key}' already exists but could not be read`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
            variable = result.variable;
            created = result.created;
          }
          if (
            !created &&
            (output?.value === undefined ||
              Redacted.value(output.value) !== Redacted.value(value))
          ) {
            variable = yield* client.updateEnvironmentVariable(variable.id, {
              value: Redacted.value(value),
            });
          }
          return attrsFrom(variable, value);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.environmentVariableId)) return;
          yield* client
            .deleteEnvironmentVariable(output.environmentVariableId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );
