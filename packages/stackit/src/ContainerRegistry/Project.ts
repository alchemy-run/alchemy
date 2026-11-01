import * as registry from "@distilled.cloud/stackit/registry";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteAllRepositories,
  findArtifactoryByName,
  getArtifactoryOrUndefined,
  type HarborCredentialsInput,
  isRegistryEnabled,
  listArtifactories,
  REGISTRY_NAME_MAX_LENGTH,
  REGISTRY_SERVICE_ID,
  REGISTRY_TIMEOUT,
  registryHostOf,
  withHarbor,
} from "./internal.ts";

/** The upstream registry a pull-through cache project mirrors. */
export interface ProjectProxy {
  /**
   * Replication adapter of the upstream, e.g. `docker-hub`. List the valid
   * values with {@link ListReplicationAdapters}. Changing it replaces the
   * project.
   */
  registryType: string;
  /** URL of the upstream registry. Updates in place. */
  url: string;
  /** Description of the upstream. Updates in place; omit to leave it alone. */
  description?: string;
  /**
   * Credentials for the upstream. Updates in place. STACKIT never returns the
   * secret, so Alchemy re-sends it when it differs from the last deploy's.
   */
  credentials?: {
    /** Access key or username at the upstream. */
    accessKey: string;
    /** Secret at the upstream. */
    accessSecret: Redacted.Redacted<string>;
  };
}

export interface ProjectProps {
  /**
   * Name of the registry project, the first segment of its image paths. 5-255
   * characters matching `^[a-z0-9]+(?:[._-][a-z0-9]+)*$`. Changing it replaces
   * the project.
   *
   * If omitted, a unique name is generated from the stack, stage and logical ID.
   */
  name?: string;
  /**
   * Make the project a pull-through cache of an upstream registry. Adding or
   * removing it replaces the project.
   */
  proxy?: ProjectProxy;
  /**
   * Take ownership of an existing Harbor project of this name (`claim` on
   * `CreateArtifactory`) instead of creating one. It only matters when the
   * project is created.
   *
   * @default false
   */
  claim?: boolean;
  /**
   * Delete every repository in the project before deleting it, because Harbor
   * refuses to delete a project that still holds images. Needs
   * {@link harborCredentials}: images live on the registry's own API.
   *
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Who empties the project for {@link forceDestroy}: a Harbor user's CLI secret,
   * or a robot account allowed to list and delete repositories. Never a
   * `RobotAccount` of this project, because destroying the stack deletes the
   * robot first.
   */
  harborCredentials?: HarborCredentialsInput;
  /**
   * STACKIT project that owns the registry project. Defaults to the profile's
   * project. Changing it replaces the project.
   */
  projectId?: string;
  /**
   * Region of the registry project. Defaults to the profile's region. Changing
   * it replaces the project.
   */
  region?: string;
}

export interface ProjectAttributes {
  /** STACKIT id of the project (the API calls the object an Artifactory). */
  artifactoryId: string;
  /** Name of the registry project. */
  name: string;
  /** Base URL of the registry, as STACKIT reports it. */
  url: string;
  /** Registry host for `docker login` and image references, taken from `url`. */
  registryHost: string;
  /** Prefix of this project's images: `<registryHost>/<name>`. */
  imagePrefix: string;
  /** `Reconciling`, `Active`, `Error` or `Deleted`. `Active` after a deploy. */
  state: string;
  /** Bytes of quota the project's images consume. */
  consumedQuotaBytes: number;
  /** The upstream of a pull-through cache project. The secret is never returned. */
  proxy:
    | {
        registryType: string;
        url: string;
        description: string | undefined;
        accessKey: string | undefined;
      }
    | undefined;
  /** When the project's creation was requested (RFC 3339). */
  createTime: string;
  /** STACKIT project that owns the registry project. */
  projectId: string;
  /** Region of the registry project. */
  region: string;
}

export type Project = Resource<
  "Stackit.ContainerRegistry.Project",
  ProjectProps,
  ProjectAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Container Registry project: a namespace of container images on
 * STACKIT's Harbor registry. STACKIT's API calls the object an `Artifactory`; the
 * docs and the IAM actions (`container-registry.project.*`) call it a project.
 *
 * Images go to `<registryHost>/<name>/<image>:<tag>` (the `imagePrefix` attribute
 * plus your image). Pushing and pulling needs a {@link RobotAccount}.
 *
 * Ownership: registry projects have no labels. A project is Alchemy's when it is
 * in state or carries a generated name. A project with an explicit `name` that
 * Alchemy didn't create is reported as unowned and only taken over with
 * `--adopt`. `alchemy unsafe nuke` enumerates generated names only.
 *
 * The first deploy enables the service (`cloud.stackit.container-registry`) for
 * the STACKIT project.
 *
 * ### Creating a Project
 * **Example:** Project with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const project = yield* Stackit.ContainerRegistry.Project("Images", {});
 * // project.imagePrefix is "<registry host>/<name>"
 * ```
 *
 * **Example:** Project with a chosen name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const project = yield* Stackit.ContainerRegistry.Project("Images", {
 *   name: "acme-images",
 * });
 * ```
 *
 * ### Pull-through Cache
 * **Example:** Cache Docker Hub
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const cache = yield* Stackit.ContainerRegistry.Project("DockerHubCache", {
 *   name: "docker-hub-cache",
 *   proxy: {
 *     registryType: "docker-hub",
 *     url: "https://hub.docker.com",
 *     credentials: {
 *       accessKey: "acme",
 *       accessSecret: Redacted.make("dckr_pat_..."),
 *     },
 *   },
 * });
 * ```
 *
 * ### Pushing an Image
 * **Example:** Build and push with `@alchemy.run/docker`
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 * import * as Config from "effect/Config";
 *
 * const project = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const robot = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: project.name,
 *   registryUrl: project.url,
 *   credentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 * });
 * const image = yield* Docker.Image("App", {
 *   name: Output.interpolate`${project.imagePrefix}/app`,
 *   tag: "1.0.0",
 *   registry: {
 *     server: project.registryHost,
 *     username: robot.robotName,
 *     password: robot.secret,
 *   },
 *   build: { context: "./app" },
 * });
 * ```
 *
 * ### Deleting a Project with Images
 * **Example:** Empty the project on destroy
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const project = yield* Stackit.ContainerRegistry.Project("Images", {
 *   forceDestroy: true,
 *   harborCredentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renaming moves every image path
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A project can't be renamed: Alchemy deletes the old project and creates
 * // the new one. Images aren't moved, so push them again, and empty the old
 * // project first or set `forceDestroy`.
 * const project = yield* Stackit.ContainerRegistry.Project("Images", {
 *   name: "acme-images-v2",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Container Registry
 * @category Containers
 */
export const Project = Resource<Project>("Stackit.ContainerRegistry.Project");

/** `forceDestroy` can't reach the registry's API without an identity. */
export class ForceDestroyNeedsCredentials extends Data.TaggedError(
  "Stackit.ContainerRegistry.ForceDestroyNeedsCredentials",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/**
 * The upstream's type can't be patched, and this project's differs from the
 * desired one. It only arises on adoption: `diff` replaces a project of ours.
 */
export class ProxyTypeMismatch extends Data.TaggedError(
  "Stackit.ContainerRegistry.ProxyTypeMismatch",
)<{
  readonly resourceName: string;
  readonly observed: string | undefined;
  readonly desired: string | undefined;
  readonly message: string;
}> {}

const generatedName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: REGISTRY_NAME_MAX_LENGTH });

const resolveName = (
  id: string,
  news: Pick<ProjectProps, "name">,
  output: Pick<ProjectAttributes, "name"> | undefined,
) =>
  news.name !== undefined
    ? Effect.succeed(news.name)
    : output?.name !== undefined
      ? Effect.succeed(output.name)
      : generatedName(id);

const toAttrs = (
  projectId: string,
  region: string,
  artifactory: registry.Artifactory,
): ProjectAttributes => {
  const registryHost = registryHostOf(artifactory.url);
  return {
    artifactoryId: artifactory.id,
    name: artifactory.name,
    url: artifactory.url,
    registryHost,
    imagePrefix: `${registryHost}/${artifactory.name}`,
    state: artifactory.state,
    consumedQuotaBytes: artifactory.consumed_quota_bytes,
    proxy:
      artifactory.proxy === undefined
        ? undefined
        : {
            registryType: artifactory.proxy.registry_type,
            url: artifactory.proxy.url,
            description: artifactory.proxy.description,
            accessKey: artifactory.proxy.credentials?.access_key,
          },
    createTime: artifactory.create_time,
    projectId,
    region,
  };
};

const waitForActive = (projectId: string, region: string, artifactoryId: string) =>
  waitFor({
    resource: `STACKIT registry project ${artifactoryId}`,
    read: registry.getArtifactory({ projectId, regionId: region, artifactoryId }),
    ready: (artifactory) => artifactory.state === "Active",
    failed: (artifactory) =>
      artifactory.state === "Error" || artifactory.state === "Deleted"
        ? artifactory.state
        : undefined,
    state: (artifactory) => artifactory.state,
    timeout: REGISTRY_TIMEOUT,
  });

const sameSecret = (
  left: Redacted.Redacted<string> | undefined,
  right: Redacted.Redacted<string> | undefined,
) => left !== undefined && right !== undefined && Redacted.value(left) === Redacted.value(right);

/** The `proxy` patch that takes an observed project to the desired upstream. */
const proxyDelta = (
  observed: registry.Proxy | undefined,
  desired: ProjectProxy,
  previous: ProjectProxy | undefined,
): registry.UpdateProxyRequest | undefined => {
  const delta: registry.UpdateProxyRequest = {};
  if (observed?.url !== desired.url) delta.url = desired.url;
  if (desired.description !== undefined && observed?.description !== desired.description) {
    delta.description = desired.description;
  }
  // The secret can't be observed: the last deployed one is all there is to
  // compare it with, and an adoption has none, so it's sent.
  if (
    desired.credentials !== undefined &&
    (observed?.credentials?.access_key !== desired.credentials.accessKey ||
      !sameSecret(previous?.credentials?.accessSecret, desired.credentials.accessSecret))
  ) {
    delta.credentials = {
      access_key: desired.credentials.accessKey,
      access_secret: desired.credentials.accessSecret,
    };
  }
  return Object.keys(delta).length > 0 ? delta : undefined;
};

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["artifactoryId", "name", "url", "registryHost", "imagePrefix", "projectId", "region"],

    diff: Effect.fn(function* ({ id, news, output }) {
      if (output === undefined) return undefined;
      // An explicit name can resolve to the current one, and names are unique:
      // it must be freed first. A generated name changes with the new generation.
      const proxy = rawProp<ProjectProps>(news, "proxy") as { registryType?: unknown } | undefined;
      if (
        hasUnresolvedTrigger<ProjectProps>(news, ["name", "projectId", "region"]) ||
        !isResolved(proxy?.registryType)
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<ProjectProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ProjectProps>(news);
      const env = yield* StackitEnvironment.current;
      const name = yield* resolveName(id, resolved, output);
      const sameName = name === output.name;
      if (
        !sameName ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region ||
        (resolved.proxy === undefined) !== (output.proxy === undefined) ||
        resolved.proxy?.registryType !== output.proxy?.registryType
      ) {
        return {
          action: "replace",
          deleteFirst: sameName && resolved.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const region = output?.region ?? olds?.region ?? env.region;
      // A project that never enabled the service has no registries to look at.
      if (output === undefined && !(yield* isRegistryEnabled(projectId, region))) {
        return undefined;
      }
      let artifactory =
        output?.artifactoryId === undefined
          ? undefined
          : yield* getArtifactoryOrUndefined(projectId, region, output.artifactoryId);
      const explicitName = output?.name ?? olds?.name;
      if (artifactory === undefined) {
        // A generated name carries the instance id, so this can only find this
        // generation, never the one a replacement is about to delete.
        const name = explicitName ?? (yield* generatedName(id));
        artifactory = yield* findArtifactoryByName(projectId, region, name);
      }
      if (artifactory === undefined) return undefined;
      const attrs = toAttrs(projectId, region, artifactory);
      // No labels: it is ours when it is in state, carries the generated name,
      // or is the generation being replaced.
      const owned =
        output !== undefined ||
        explicitName === undefined ||
        previous?.artifactoryId === artifactory.id;
      return owned ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      if (!(yield* isRegistryEnabled(env.projectId, env.region))) return [];
      const artifactories = yield* listArtifactories(env.projectId, env.region);
      return artifactories
        .filter((artifactory) =>
          isGeneratedPhysicalName(artifactory.name, REGISTRY_NAME_MAX_LENGTH),
        )
        .map((artifactory) => toAttrs(env.projectId, env.region, artifactory));
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const region = news.region ?? output?.region ?? env.region;
      const name = yield* resolveName(id, news, output);

      if (news.forceDestroy && news.harborCredentials === undefined) {
        return yield* new ForceDestroyNeedsCredentials({
          resourceName: name,
          message: `forceDestroy on registry project ${name} needs harborCredentials: images live on the registry's own API.`,
        });
      }

      yield* ensureServiceEnabled({ projectId, region, serviceId: REGISTRY_SERVICE_ID });

      // 1. Observe: `output` is a cache, and only counts while it still names
      // the desired project.
      let artifactory: registry.Artifactory | undefined;
      if (output?.projectId === projectId && output.region === region && output.name === name) {
        artifactory = yield* getArtifactoryOrUndefined(projectId, region, output.artifactoryId);
      }
      if (artifactory === undefined) {
        artifactory = yield* findArtifactoryByName(projectId, region, name);
      }

      // 2. Ensure.
      const created = artifactory === undefined;
      if (artifactory === undefined) {
        artifactory = yield* registry
          .createArtifactory({
            projectId,
            regionId: region,
            name,
            // Only the user's say-so, or an adoption they allowed, claims a Harbor
            // project that already exists.
            ...(news.claim === true || (output !== undefined && olds === undefined)
              ? { claim: true }
              : {}),
            ...(news.proxy !== undefined
              ? {
                  proxy: {
                    registry_type: news.proxy.registryType,
                    url: news.proxy.url,
                    ...(news.proxy.description !== undefined
                      ? { description: news.proxy.description }
                      : {}),
                    ...(news.proxy.credentials !== undefined
                      ? {
                          credentials: {
                            access_key: news.proxy.credentials.accessKey,
                            access_secret: news.proxy.credentials.accessSecret,
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          })
          .pipe(
            // A concurrent create won the race: observe it. A name that is
            // taken by something we can't see still fails.
            Effect.catchTag("Conflict", (error) =>
              findArtifactoryByName(projectId, region, name).pipe(
                Effect.flatMap((found) =>
                  found === undefined ? Effect.fail(error) : Effect.succeed(found),
                ),
              ),
            ),
          );
      } else if (
        (news.proxy === undefined) !== (artifactory.proxy === undefined) ||
        news.proxy?.registryType !== artifactory.proxy?.registry_type
      ) {
        return yield* new ProxyTypeMismatch({
          resourceName: name,
          observed: artifactory.proxy?.registry_type,
          desired: news.proxy?.registryType,
          message: `Registry project ${name} has upstream type ${artifactory.proxy?.registry_type ?? "(none)"}, which can't be changed to ${news.proxy?.registryType ?? "(none)"} in place.`,
        });
      }

      const artifactoryId = artifactory.id;
      artifactory = yield* waitForActive(projectId, region, artifactoryId);

      // 3. Sync: only the upstream is mutable, diffed against the observed
      // project. A project created just now already has what it was created with.
      if (news.proxy !== undefined) {
        const delta = proxyDelta(artifactory.proxy, news.proxy, created ? news.proxy : olds?.proxy);
        if (delta !== undefined) {
          yield* registry.patchArtifactory({
            projectId,
            regionId: region,
            artifactoryId,
            proxy: delta,
          });
          artifactory = yield* waitForActive(projectId, region, artifactoryId);
        }
      }

      // 4. Return.
      return toAttrs(projectId, region, artifactory);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const { projectId, region, artifactoryId, name, url } = output;
      const current = yield* getArtifactoryOrUndefined(projectId, region, artifactoryId);
      if (current === undefined) return;
      if (olds?.forceDestroy && olds.harborCredentials !== undefined) {
        yield* deleteAllRepositories(name).pipe(withHarbor(url, olds.harborCredentials));
      }
      // A refusal because the project still holds images is the user's to see.
      yield* registry
        .deleteArtifactory({ projectId, regionId: region, artifactoryId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT registry project ${artifactoryId}`,
        read: getArtifactoryOrUndefined(projectId, region, artifactoryId),
        failed: (artifactory) => (artifactory.state === "Error" ? artifactory.state : undefined),
        state: (artifactory) => artifactory.state,
        timeout: REGISTRY_TIMEOUT,
      });
    }),
  });
