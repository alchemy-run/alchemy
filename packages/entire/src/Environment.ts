import * as Entire from "@distilled.cloud/entire";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeClient } from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

export type EnvironmentProps = {
  /** ID of the project the environment belongs to. Changing it replaces the environment. */
  projectId: string;
  /**
   * Display name.
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /** Free-form description. */
  description?: string;
  /**
   * Sandbox lifetime in minutes, 1–60 (Daytona: idle time; E2B: initial
   * wall-clock lifetime, renewed while in use).
   * @default the cell's default
   */
  autoStopMinutes?: number;
};

export type Environment = Resource<
  "Entire.Environment",
  EnvironmentProps,
  {
    /** Environment ID (ULID), stable across versions. */
    id: string;
    /** ID of the owning project. */
    projectId: string;
    name: string;
    description: string;
    autoStopMinutes: number | undefined;
    /** Current version; each replace saves a new one. */
    version: number;
  },
  never,
  Providers
>;

/**
 * A sandbox configuration that Entire agents run in. It belongs to a
 * {@link Project} and can be shared by any of its {@link Agent}s. Saving
 * an environment runs nothing.
 *
 * Every change saves a new version. Entire never deletes environments, so
 * delete archives it.
 *
 * ### Creating an Environment
 * **Example:** A sandbox that stops after 30 idle minutes
 * ```typescript
 * const sandbox = yield* Entire.Environment("sandbox", {
 *   projectId: project.id,
 *   description: "Default agent sandbox",
 *   autoStopMinutes: 30,
 * });
 * ```
 *
 * @resource
 * @product Agent
 */
export const Environment = Resource<Environment>("Entire.Environment");

const toAttrs = (env: Entire.environments.Environment) => ({
  id: env.id,
  projectId: env.project_id,
  name: env.name,
  description: env.description,
  autoStopMinutes: env.auto_stop_minutes ?? undefined,
  version: env.version,
});

export const EnvironmentProvider = () =>
  Provider.effect(
    Environment,
    Effect.gen(function* () {
      const client = yield* makeClient;

      const envName = (id: string, props: { name?: string }) =>
        props.name ? Effect.succeed(props.name) : createPhysicalName({ id, maxLength: 128 });

      const getActive = Effect.fn(function* (projectId: string, envId: string) {
        const { host, project, cell } = yield* client.project(projectId);
        const env = yield* cell(
          Entire.environments.getProjectEnvironment({ host, project, id: envId }),
        ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        return env && env.archived_at === null ? env : undefined;
      });

      const findByName = Effect.fn(function* (projectId: string, name: string) {
        const { host, project, cell } = yield* client.project(projectId);
        return yield* cell(
          Entire.environments.listProjectEnvironments.items({ host, project }).pipe(
            Stream.filter((env) => env.name === name && env.archived_at === null),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          ),
        );
      });

      return {
        stables: ["id", "projectId"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (news.projectId !== output.projectId) return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const env = yield* getActive(output.projectId, output.id);
          return env ? toAttrs(env) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          const name = yield* envName(id, news);
          const { host, project, cell } = yield* client.project(news.projectId);
          const desired = {
            name,
            description: news.description ?? "",
            auto_stop_minutes: news.autoStopMinutes ?? null,
          };

          // Observe
          const observed = output?.id
            ? yield* getActive(news.projectId, output.id)
            : yield* findByName(news.projectId, name);

          // Ensure -- the instance id is a stable Idempotency-Key, so a
          // create retried after a lost response saves nothing new.
          if (!observed) {
            return toAttrs(
              yield* cell(
                Entire.environments.createProjectEnvironment({
                  host,
                  project,
                  idempotencyKey: instanceId,
                  ...desired,
                }),
              ),
            );
          }

          // Sync -- replace saves a new version only when something differs.
          if (
            observed.name === desired.name &&
            observed.description === desired.description &&
            observed.auto_stop_minutes === desired.auto_stop_minutes
          ) {
            return toAttrs(observed);
          }
          return toAttrs(
            yield* cell(
              Entire.environments.replaceProjectEnvironment({
                host,
                project,
                id: observed.id,
                ifMatch: observed.etag,
                ...desired,
              }),
            ),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          const env = yield* getActive(output.projectId, output.id).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!env) return;
          const { host, project, cell } = yield* client.project(output.projectId);
          yield* cell(
            Entire.environments.archiveProjectEnvironment({
              host,
              project,
              id: env.id,
              ifMatch: env.etag,
            }),
          ).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
