import * as sca from "@distilled.cloud/stackit/sca";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { type ProjectScopedProps, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { childrenLeftAfterSettling, waitFor } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import type { EnvironmentConsumer } from "./EnvironmentSecret.ts";
import {
  ensureContainerApplicationsEnabled,
  type EnvironmentScope,
  listRegistries,
  removeRegistry,
  withRegistryLock,
} from "./internal.ts";

export interface EnvironmentRegistryProps extends ProjectScopedProps {
  /** Environment that holds the login. Changing it replaces the login. */
  environmentId: string;
  /**
   * Server of the registry, such as `registry.onstackit.cloud` or the spec's example
   * `https://index.docker.io/v1/`. Changing it replaces the login.
   */
  server: string;
  /** Username of the login. Updates in place. */
  username: string;
  /** Password or token of the login. Updates in place. */
  password: string | Redacted.Redacted<string>;
  /**
   * Destroy the login even when something other than this stack still uses it. An
   * application using it may then fail to pull its image. Deploy it on its own before a change
   * that replaces the login: an old login keeps the props it was deployed with.
   * @default false
   */
  forceDestroy?: boolean;
  /** Project of the environment. Defaults to the profile's project. Changing it replaces the login. */
  projectId?: string;
  /** Region of the environment. Defaults to the profile's region. Changing it replaces the login. */
  region?: string;
}

export interface EnvironmentRegistryAttributes {
  /** Environment that holds the login. */
  environmentId: string;
  /** Project of the environment. */
  projectId: string;
  /** Region of the environment. */
  region: string;
  /** Server of the registry. */
  server: string;
  /** Username of the login, if the API returns it. */
  username: string | undefined;
  /** What uses the login, when it was last read. */
  consumers: EnvironmentConsumer[];
  /** When the login was created, in RFC 3339. */
  createdAt: string | undefined;
  /** When the login last changed, in RFC 3339. */
  updatedAt: string | undefined;
}

export type EnvironmentRegistry = Resource<
  "Stackit.ContainerApplications.EnvironmentRegistry",
  EnvironmentRegistryProps,
  EnvironmentRegistryAttributes,
  never,
  Providers
>;

/**
 * A registry login in a STACKIT Container Applications environment, for applications there
 * to pull private images with. The password never appears in attributes.
 *
 * A server is the login's only identity, and the API has no labels. A server already in the
 * environment with no state behind it is reported as unowned and only taken over with
 * `--adopt`.
 *
 * :::caution[Removing a login is unconfirmed]
 * The API has no delete, and its spec doesn't say how to remove a registry from the
 * collection. A destroy sends the other servers and checks the result, and fails with
 * `Stackit.ContainerApplications.EnvironmentRegistryNotDeleted` if the server is still
 * there, so a password can't quietly stay behind. If that happens, remove it in the STACKIT
 * portal, or decorate the resource with `Alchemy.RemovalPolicy.retain()` to leave it.
 * :::
 *
 * ### Creating a Registry Login
 * **Example:** A token for GitHub Container Registry
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const environment = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const token = yield* Config.Redacted("GHCR_TOKEN");
 * const ghcr = yield* Stackit.ContainerApplications.EnvironmentRegistry("Ghcr", {
 *   environmentId: environment.environmentId,
 *   server: "ghcr.io",
 *   username: "my-org",
 *   password: token,
 * });
 * ```
 *
 * **Example:** A pull-only robot of a STACKIT Container Registry project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const environment = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const images = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const puller = yield* Stackit.ContainerRegistry.RobotAccount("Puller", {
 *   project: images.name,
 *   registryUrl: images.url,
 *   credentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 *   permissions: [{ resource: "repository", action: "pull" }],
 * });
 * const login = yield* Stackit.ContainerApplications.EnvironmentRegistry("Images", {
 *   environmentId: environment.environmentId,
 *   server: images.registryHost,
 *   username: puller.robotName,
 *   password: puller.secret,
 * });
 * ```
 *
 * ### Running a private image
 * **Example:** Pull an application's image with the login
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const environment = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const token = yield* Config.Redacted("GHCR_TOKEN");
 * const ghcr = yield* Stackit.ContainerApplications.EnvironmentRegistry("Ghcr", {
 *   environmentId: environment.environmentId,
 *   server: "ghcr.io",
 *   username: "my-org",
 *   password: token,
 * });
 * const api = yield* Stackit.ContainerApplications.Application("Api", {
 *   // Taken from the login, so the application follows it.
 *   environmentId: ghcr.environmentId,
 *   image: "ghcr.io/my-org/api:v1.0.0",
 * });
 * ```
 *
 * :::caution[Changing `environmentId`, `server`, `projectId` or `region` replaces the Login]
 * The login is written at its new place and removed from the old one.
 * :::
 *
 * @resource
 * @product STACKIT Container Applications
 * @category Container Applications
 */
export const EnvironmentRegistry = Resource<EnvironmentRegistry>(
  "Stackit.ContainerApplications.EnvironmentRegistry",
);

/** Something other than this stack still uses the login. */
export class EnvironmentRegistryInUse extends Data.TaggedError(
  "Stackit.ContainerApplications.EnvironmentRegistryInUse",
)<{
  readonly server: string;
  readonly consumers: ReadonlyArray<string>;
  readonly message: string;
}> {}

/** The server is still in the environment after the update meant to remove it. */
export class EnvironmentRegistryNotDeleted extends Data.TaggedError(
  "Stackit.ContainerApplications.EnvironmentRegistryNotDeleted",
)<{
  readonly server: string;
  readonly message: string;
}> {}

const find = (scope: EnvironmentScope, server: string) =>
  listRegistries(scope).pipe(
    Effect.map((registries) => registries.find((registry) => registry.server === server)),
  );

const toAttrs = (scope: EnvironmentScope, registry: sca.EnvironmentRegistry) =>
  ({
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    region: scope.region,
    server: registry.server,
    username: registry.username,
    consumers: (registry.status?.consumers ?? []).map(({ id, displayName, container }) => ({
      id,
      displayName,
      container,
    })),
    createdAt: registry.createdAt,
    updatedAt: registry.updatedAt,
  }) satisfies EnvironmentRegistryAttributes;

export const EnvironmentRegistryProvider = () =>
  Provider.succeed(EnvironmentRegistry, {
    stables: ["environmentId", "projectId", "region", "server"],
    // No `list`: there are no labels, so nuke can't tell ours from anyone else's.

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved identity can resolve to where the login already is, and a server can't
      // exist twice in one environment, so this generation has to go first. That's before any
      // application of this stack lets go of it, so a plan is where to refuse.
      if (
        hasUnresolvedTrigger<EnvironmentRegistryProps>(news, [
          "environmentId",
          "server",
          "projectId",
          "region",
        ])
      ) {
        if (olds?.forceDestroy !== true) {
          const registry = yield* find(
            {
              projectId: output.projectId,
              region: output.region,
              environmentId: output.environmentId,
            },
            output.server,
          );
          const consumers = (registry?.status?.consumers ?? []).map(
            (consumer) => consumer.displayName ?? consumer.id ?? "unknown",
          );
          if (consumers.length > 0) {
            return yield* new EnvironmentRegistryInUse({
              server: output.server,
              consumers,
              message: `Registry ${output.server} is still used by: ${consumers.join(", ")}. This change deletes the old login before they let go of it, so nothing was changed. Stop using it in a deploy of its own, or deploy forceDestroy: true on the login on its own, then make this change.`,
            });
          }
        }
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<EnvironmentRegistryProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        resolved.environmentId !== output.environmentId ||
        resolved.server !== output.server ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const { projectId, region } = yield* resolveProjectScope(olds, output);
      const environmentId = output?.environmentId ?? olds?.environmentId;
      const server = output?.server ?? olds?.server;
      if (typeof environmentId !== "string" || typeof server !== "string") return undefined;
      const scope = { projectId, region, environmentId };
      const registry = yield* find(scope, server);
      if (registry === undefined) return undefined;
      const attrs = toAttrs(scope, registry);
      if (output !== undefined) return attrs;
      // A server is only unique per environment.
      return previous?.server === server &&
        previous.environmentId === environmentId &&
        previous.projectId === projectId &&
        previous.region === region
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { projectId, region } = yield* resolveProjectScope(news, output);
      const scope = { projectId, region, environmentId: news.environmentId };
      const server = news.server;

      yield* ensureContainerApplicationsEnabled(projectId, region);

      const registry = yield* Effect.gen(function* () {
        // Observe, and write only what differs. A response that hides the password reads as
        // a difference and resends it, which is safe. The body is "the subset of registries
        // to merge or replace", so this one server is all it holds.
        const observed = yield* find(scope, server);
        if (
          observed === undefined ||
          observed.username !== news.username ||
          secretsDiffer(observed.password, news.password)
        ) {
          yield* sca.updateEnvironmentRegistries({
            ...scope,
            registries: [{ server, username: news.username, password: news.password }],
          });
        }
        return yield* waitFor({
          resource: `STACKIT Container Applications registry ${server}`,
          read: find(scope, server),
          ready: (found) => found !== undefined,
          timeout: "1 minute",
        });
      }).pipe(withRegistryLock(scope));

      return toAttrs(scope, registry!);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const scope = {
        projectId: output.projectId,
        region: output.region,
        environmentId: output.environmentId,
      };
      const server = output.server;
      if (olds?.forceDestroy !== true && force !== true) {
        // Applications of this stack go first. What is left after they settle is someone else's.
        const left = yield* childrenLeftAfterSettling(
          find(scope, server).pipe(Effect.map((registry) => registry?.status?.consumers ?? [])),
        );
        if (left.length > 0) {
          const consumers = left.map(
            (consumer) => consumer.displayName ?? consumer.id ?? "unknown",
          );
          return yield* new EnvironmentRegistryInUse({
            server,
            consumers,
            message: `Registry ${server} is still used by: ${consumers.join(", ")}. Stop using it first, or deploy forceDestroy: true on the login. A login already being replaced keeps the props it was deployed with, so only stopping its use finishes that replacement.`,
          });
        }
      }
      if (yield* removeRegistry(scope, server)) {
        return yield* new EnvironmentRegistryNotDeleted({
          server,
          message: `Registry ${server} is still in environment ${output.environmentId} after the update meant to remove it, and the STACKIT API has no delete. Remove it in the portal, or retain it with Alchemy.RemovalPolicy.retain().`,
        });
      }
    }),
  });
