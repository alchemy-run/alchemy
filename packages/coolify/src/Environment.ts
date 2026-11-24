import * as Coolify from "@distilled.cloud/coolify";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isGeneratedName, resolveName } from "./internal/naming.ts";
import type { Providers } from "./Providers.ts";

export interface EnvironmentProps {
  /**
   * UUID of the project the environment belongs to, usually
   * `project.projectUuid`. Changing it replaces the environment.
   */
  project: string;
  /**
   * Environment name, unique within the project. If omitted, a unique name
   * is generated from the stack, stage and logical ID. Renaming updates
   * the environment in place.
   */
  name?: string;
  /** Free-form description shown in the dashboard. Updates in place. */
  description?: string;
}

export type Environment = Resource<
  "Coolify.Environment",
  EnvironmentProps,
  {
    /** Environment UUID. Pass it as `environment` to applications and databases. */
    environmentUuid: string;
    /** UUID of the project the environment belongs to. */
    projectUuid: string;
    /** Environment name, unique within the project. */
    name: string;
    /** Environment description, if any. */
    description: string | undefined;
  },
  never,
  Providers
>;

/**
 * An environment inside a Coolify project, such as `staging` or a
 * per-branch preview. Applications, databases and services are deployed
 * into an environment.
 *
 * Every project comes with a `production` environment. Declare an
 * `Environment` for each further one you want Alchemy to manage.
 *
 * Coolify refuses to delete an environment that still has resources.
 * Alchemy deletes a stack's applications and databases first, and retries
 * the environment delete briefly while Coolify finishes removing them.
 *
 * @see https://coolify.io/docs/knowledge-base/environments
 *
 * ### Creating an Environment
 * **Example:** A staging environment
 * ```typescript
 * const project = yield* Coolify.Project("app", {});
 *
 * const staging = yield* Coolify.Environment("staging", {
 *   project: project.projectUuid,
 *   name: "staging",
 * });
 * ```
 *
 * **Example:** One environment per stage
 * ```typescript
 * const env = yield* Coolify.Environment("env", {
 *   project: project.projectUuid,
 *   description: "Created by Alchemy for this stage",
 * });
 *
 * yield* Coolify.Application("web", {
 *   project: project.projectUuid,
 *   environment: env.environmentUuid,
 *   server: "<server-uuid>",
 *   image: "nginx:1.27-alpine",
 *   ports: [80],
 * });
 * ```
 *
 * @resource
 * @product Environment
 */
export const Environment = Resource<Environment>("Coolify.Environment");

/** Coolify returned an environment without the fields Alchemy needs. */
export class EnvironmentUnexpectedResponse extends Data.TaggedError(
  "Coolify.EnvironmentUnexpectedResponse",
)<{ readonly message: string }> {}

const toAttrs = (projectUuid: string, environment: Coolify.Environment) =>
  Effect.gen(function* () {
    if (!environment.uuid || environment.name === undefined) {
      return yield* new EnvironmentUnexpectedResponse({
        message: `Coolify returned an environment of project ${projectUuid} without a uuid or name`,
      });
    }
    return {
      environmentUuid: environment.uuid,
      projectUuid,
      name: environment.name,
      description: environment.description ?? undefined,
    } satisfies Environment["Attributes"];
  });

export const EnvironmentProvider = () =>
  Provider.effect(
    Environment,
    Effect.gen(function* () {
      const getEnvironment = yield* Coolify.getEnvironmentByNameOrUuid;
      const createEnvironment = yield* Coolify.createEnvironment;
      const updateEnvironment = yield* Coolify.updateEnvironment;
      const deleteEnvironment = yield* Coolify.deleteEnvironment;

      // `{environment_name_or_uuid}` matches a name first, then a uuid.
      const observe = (projectUuid: string, nameOrUuid: string) =>
        getEnvironment({ uuid: projectUuid, environment_name_or_uuid: nameOrUuid }).pipe(
          Effect.catchTag("NotFound", () => Effect.undefined),
        );

      return {
        stables: ["environmentUuid", "projectUuid"],
        nuke: { dependsOn: ["Coolify.Project"] },

        diff: Effect.fn(function* ({ id, news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          if (news.project !== output.projectUuid) return { action: "replace" } as const;
          const name = yield* resolveName(id, news.name, output.name);
          if (name !== output.name || (news.description ?? undefined) !== output.description) {
            return { action: "update" } as const;
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.environmentUuid) {
            const environment = yield* observe(output.projectUuid, output.environmentUuid);
            return environment ? yield* toAttrs(output.projectUuid, environment) : undefined;
          }
          if (!olds?.project) return undefined;
          const name = yield* resolveName(id, olds.name);
          const environment = yield* observe(olds.project, name);
          if (!environment) return undefined;
          const attrs = yield* toAttrs(olds.project, environment);
          return (yield* isGeneratedName(id, environment.name)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const projectUuid = news.project;
          const name = yield* resolveName(id, news.name, output?.name);

          // Observe — by the cached uuid when it belongs to this project.
          let environment =
            output?.environmentUuid && output.projectUuid === projectUuid
              ? yield* observe(projectUuid, output.environmentUuid)
              : undefined;

          // Ensure — create when missing. A name conflict means a peer or an
          // earlier crashed run created it: `read` has already settled
          // ownership, so take it over by name.
          if (environment === undefined) {
            const created = yield* createEnvironment({ uuid: projectUuid, name }).pipe(
              Effect.map((response) => response.uuid),
              Effect.catchTag("Conflict", () => Effect.succeed(name)),
            );
            if (!created) {
              return yield* new EnvironmentUnexpectedResponse({
                message: "Coolify did not return the new environment's uuid",
              });
            }
            environment = yield* getEnvironment({
              uuid: projectUuid,
              environment_name_or_uuid: created,
            });
          }

          // Sync — name and description against the observed environment.
          if (
            environment.name !== name ||
            (environment.description ?? undefined) !== news.description
          ) {
            yield* updateEnvironment({
              uuid: projectUuid,
              environment_name_or_uuid: environment.uuid!,
              name,
              description: news.description ?? "",
            });
            environment = yield* getEnvironment({
              uuid: projectUuid,
              environment_name_or_uuid: environment.uuid!,
            });
          }

          return yield* toAttrs(projectUuid, environment);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteEnvironment({
            uuid: output.projectUuid,
            environment_name_or_uuid: output.environmentUuid,
          }).pipe(
            Effect.retry({
              while: (e) => e._tag === "EnvironmentHasResources",
              schedule: Schedule.spaced("3 seconds"),
              times: 15,
            }),
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );
