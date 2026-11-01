import * as sca from "@distilled.cloud/stackit/sca";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { type ProjectScopedProps, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { waitFor } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  ContainerApplicationsIdMissing,
  ensureContainerApplicationsEnabled,
  ENVIRONMENT_TIMEOUT,
  generatedEnvironmentName,
  getEnvironmentOrUndefined,
  listAllEnvironments,
} from "./internal.ts";

export interface EnvironmentProps extends ProjectScopedProps {
  /**
   * Name of the environment. The API can't rename one, so changing it replaces the
   * environment, and the old one stays behind. If omitted, the name is generated from the
   * stack, stage and logical ID, with no generation in it, so a later deploy picks the
   * same environment up again.
   */
  displayName?: string;
  /**
   * Project that owns the environment. Defaults to the profile's project. Changing it
   * replaces the environment, and the old one stays behind.
   */
  projectId?: string;
  /**
   * Region of the environment. Defaults to the profile's region. Changing it replaces the
   * environment, and the old one stays behind.
   */
  region?: string;
}

export interface EnvironmentAttributes {
  /** STACKIT id of the environment. */
  environmentId: string;
  /** Project that owns the environment. */
  projectId: string;
  /** Region of the environment. */
  region: string;
  /** Name of the environment. */
  displayName: string;
  /** Whether this is the project's default environment. */
  default: boolean;
  /** The API's status of the environment, e.g. `CURRENT_STATUS_CREATED`. */
  status: string | undefined;
  /** How many applications the environment held when it was last read. */
  applicationsNumber: number | undefined;
  /** When the environment was created, in RFC 3339. */
  createdAt: string | undefined;
}

export type Environment = Resource<
  "Stackit.ContainerApplications.Environment",
  EnvironmentProps,
  EnvironmentAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Container Applications environment: an isolated scope in a project that
 * holds applications, secrets and registry logins.
 *
 * :::caution[An environment can't be deleted]
 * The API has create, get and list for environments, and nothing else. So destroying this
 * resource only drops it from state: the environment stays in the project, and
 * `alchemy unsafe nuke` can't remove it either. Remove it in the STACKIT portal if the
 * portal offers that. Unless you pass a `displayName`, its name is stable, so the next
 * deploy of the same stack and stage picks it up again rather than leaving another behind.
 * :::
 *
 * :::caution[Beta API]
 * Container Applications is a beta API, available in `eu01` only.
 * :::
 *
 * The API has no labels, so Alchemy can't mark an environment as its own. One with a
 * generated name is taken as this resource's. One with your `displayName`, found with no
 * state, is reported as unowned and only used with `--adopt`, and so is the project's
 * default environment.
 *
 * ### Creating an Environment
 * **Example:** An environment with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const environment = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * ```
 *
 * **Example:** An environment with a name you choose
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const environment = yield* Stackit.ContainerApplications.Environment("Apps", {
 *   displayName: "sandbox-env",
 * });
 * ```
 *
 * ### Running an Application in it
 * **Example:** A pre-built image in the environment
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const environment = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const web = yield* Stackit.ContainerApplications.Application("Web", {
 *   environmentId: environment.environmentId,
 *   image: "nginxinc/nginx-unprivileged",
 * });
 * ```
 *
 * ### Reading an Environment at runtime
 * **Example:** Read the environment from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const apps = yield* Apps;
 *     const getEnvironment = yield* Stackit.ContainerApplications.GetEnvironment(apps);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getEnvironment();
 *         return yield* HttpServerResponse.json({ status: live.status?.current });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.GetEnvironmentHttp)),
 * ) {}
 * ```
 *
 * :::caution[Changing `displayName`, `projectId` or `region` replaces the Environment]
 * A new environment is created, and its applications, secrets and registries are replaced
 * in it. The old environment stays behind, because the API can't delete it.
 * :::
 *
 * @resource
 * @product STACKIT Container Applications
 * @category Container Applications
 */
export const Environment = Resource<Environment>("Stackit.ContainerApplications.Environment");

const toAttrs = (
  environment: sca.Environment,
  environmentId: string,
  projectId: string,
  region: string,
): EnvironmentAttributes => ({
  environmentId,
  projectId,
  region,
  displayName: environment.displayName,
  default: environment.default ?? false,
  status: environment.status?.current,
  applicationsNumber: environment.status?.applicationsNumber,
  createdAt: environment.createdAt,
});

export const EnvironmentProvider = () =>
  Provider.succeed(Environment, {
    stables: ["environmentId", "projectId", "region"],
    // No `list`, since ownership can't be shown without labels. And no delete API: nuke could
    // only report it as still there, forever.
    nuke: { skip: true },

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved scope can resolve to the one the environment is already in. Create
      // then finds it again by name, which the missing delete makes harmless.
      if (hasUnresolvedTrigger<EnvironmentProps>(news, ["displayName", "projectId", "region"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<EnvironmentProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace" } as const;
      }
      // `olds` first, so a name the API normalized can't replace on every deploy.
      const renamed =
        olds !== undefined
          ? resolved.displayName !== olds.displayName
          : (resolved.displayName ?? (yield* generatedEnvironmentName(id))) !== output.displayName;
      return renamed ? ({ action: "replace" } as const) : undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const { projectId, region } = yield* resolveProjectScope(olds, output);
      const displayName =
        output?.displayName ?? olds?.displayName ?? (yield* generatedEnvironmentName(id));
      let environment: sca.Environment | undefined =
        output !== undefined
          ? yield* getEnvironmentOrUndefined({
              projectId,
              region,
              environmentId: output.environmentId,
            })
          : undefined;
      if (environment === undefined) {
        const environments = yield* listAllEnvironments(projectId, region);
        environment = environments.find((candidate) => candidate.displayName === displayName);
      }
      if (environment?.id === undefined) return undefined;
      const attrs = toAttrs(environment, environment.id, projectId, region);
      if (output?.environmentId === environment.id) return attrs;
      // A name is only unique per project and region.
      if (
        previous?.displayName === displayName &&
        previous.projectId === projectId &&
        previous.region === region
      ) {
        return attrs;
      }
      // With no labels, a generated name is all that says it is ours.
      return olds?.displayName === undefined && !attrs.default ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { projectId, region } = yield* resolveProjectScope(news, output);
      const displayName = news.displayName ?? (yield* generatedEnvironmentName(id));

      yield* ensureContainerApplicationsEnabled(projectId, region);

      // Observe: `output` is a cache, and its id only counts in this scope.
      let environment: sca.Environment | undefined =
        output?.projectId === projectId && output.region === region
          ? yield* getEnvironmentOrUndefined({
              projectId,
              region,
              environmentId: output.environmentId,
            })
          : undefined;
      const findByName = listAllEnvironments(projectId, region).pipe(
        Effect.map((environments) =>
          environments.find((candidate) => candidate.displayName === displayName),
        ),
      );
      // The engine has already checked the name with `read`. Nothing here can be lost by
      // reusing an environment found by name: there is no update and no delete.
      if (environment === undefined) environment = yield* findByName;

      // Ensure
      if (environment === undefined) {
        environment = yield* sca
          .createEnvironment({ projectId, region, displayName })
          .pipe(
            Effect.catchTag("Conflict", (conflict) =>
              findByName.pipe(
                Effect.flatMap((found) =>
                  found === undefined ? Effect.fail(conflict) : Effect.succeed(found),
                ),
              ),
            ),
          );
      }
      const environmentId = environment.id;
      if (environmentId === undefined) {
        return yield* new ContainerApplicationsIdMissing({
          resourceName: displayName,
          message: `STACKIT returned environment ${displayName} without an id`,
        });
      }

      // There is nothing to sync: the API has no update for an environment.
      const ready = yield* waitFor({
        resource: `STACKIT Container Applications environment ${displayName}`,
        read: sca.getEnvironment({ projectId, region, environmentId }),
        ready: (observed) => observed.status?.current === "CURRENT_STATUS_CREATED",
        state: (observed) => observed.status?.current,
        timeout: ENVIRONMENT_TIMEOUT,
      });
      return toAttrs(ready, environmentId, projectId, region);
    }),

    // The API can't delete an environment, so all this can do is say so.
    delete: Effect.fn(function* ({ output, session }) {
      yield* session.note(
        `Environment ${output.displayName} stays in project ${output.projectId}: the API can't delete an environment.`,
      );
    }),
  });
