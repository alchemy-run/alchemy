/**
 * TODO: When an image gets rebuilt, a <none> tagged image is left dangling.
 * */

import dockerIgnoreBuilder from "@balena/dockerignore";
import type Dockerode from "dockerode";
import type { ImageInspectInfo } from "dockerode";
import fs, { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import tar from "tar-fs";
import type { Context } from "../../context.ts";
import { Resource } from "../../resource.ts";
import { formatBytes, parseBytes } from "../../util/bytes.ts";
import { diff } from "../../util/diff.ts";
import { logger } from "../../util/logger.ts";
import { DockerHost } from "./docker-host.ts";
import type { DockerRegistry } from "./docker-registry.ts";

export interface ImageProps<Registries extends Record<string, DockerRegistry>> {
  ref: string;
  build?: boolean | ImageBuildProps;
  /**
   * Push policy and settings
   * - `true` | `'missing'`: push the image to the registry if it is not found in the registry.
   * - `false` | `'never'`: never push the image to the registry
   * - `'always'`: always push the image to the registry, equivalent to `force: true`
   */
  push?: boolean | ImagePushPolicyShorthand | ImagePushProps<Registries>;
  /**
   * Pull policy and settings
   * - `true` | `'missing'`: pull if the image is not found locally
   * - `false` | `'never'`: never pull
   * - `'always'`: always pull, equivalent to `force: true`
   */
  pull?: boolean | ImagePullPolicyShorthand | ImagePullProps<Registries>;
  registry?: DockerRegistry | (keyof Registries & string);
  dockerHost?: DockerHost<Registries>;
}

/**
 * Docker Image resource
 */
export interface Image
  extends Resource<"docker::api::Image">,
    Dockerode.ImageInspectInfo {}

/**
 * Create and manage a Docker Image
 */
export const Image = Resource(
  "docker::api::Image",
  {
    alwaysUpdate: true,
  },
  async function <const Registries extends Record<string, DockerRegistry>>(
    this: Context<Image, ImageProps<Registries>>,
    _id: string,
    props: ImageProps<Registries>,
  ): Promise<Image> {
    // Initialize Docker API client
    const dockerHost = await DockerHost<Record<string, DockerRegistry>>(
      props.dockerHost,
    );
    const { dockerode: api } = dockerHost;
    const ref = parseImageRef(props.ref);

    // Parse pull config
    const pullConfig = parsePullConfig(props);
    const pushConfig = parsePushConfig(props);
    const buildConfig = parseBuildConfig(props);
    const changes = diff(
      {
        ...(typeof this.props?.build === "object" ? this.props.build : {}),
      },
      {
        ...(typeof props.build === "object" ? props.build : {}),
      },
    );
    const buildRequired = changes.any();

    // shorthands
    const pull = () =>
      pullImage({
        id: this.id,
        fqn: this.fqn,
        pullConfig,
        props,
        dockerHost,
        api,
        ref,
      });
    const push = () =>
      pushImage({
        id: this.id,
        fqn: this.fqn,
        pushConfig,
        props,
        dockerHost,
        api,
        ref,
      });
    const build = () =>
      buildImage({
        id: this.id,
        fqn: this.fqn,
        buildConfig,
        props,
        dockerHost,
        api,
        ref,
      });

    // check if the image exists locally
    const image = await api
      .getImage(ref.fqn)
      .inspect()
      .catch((err) => {
        const reason = "reason" in err ? err.reason : err;
        if (reason === "no such image") {
          return null;
        }
        throw err;
      });

    // build.force takes precedence over pull.force
    if (buildConfig.enabled && (buildConfig.force || buildRequired)) {
      const builtImage = await build();
      if (pushConfig.enabled) await push();
      return this(builtImage!);
    }

    if (pullConfig.enabled && (pullConfig.force || !image)) {
      const pulledImage = await pull();
      if (pushConfig.enabled) await push();

      return this(pulledImage);
    } else if (image) {
      logger.task(this.fqn, {
        prefix: "cached",
        prefixColor: "yellowBright",
        resource: this.id,
        message: `Image ${ref.fqn} already exists locally`,
        status: "success",
      });

      if (pushConfig.enabled) await push();
      return this(image);
    }

    if (buildConfig.enabled) {
      const builtImage = await build();
      if (pushConfig.enabled) await push();
      return this(builtImage!);
    }

    throw new Error(`Image ${ref.fqn} not found locally`);
  },
);

// -----------------------------------------------------------------------------
// Pulling
// -----------------------------------------------------------------------------

export type ImagePullPolicyShorthand = "missing" | "always" | "never";
export interface ImagePullProps<
  Registries extends Record<string, DockerRegistry> = Record<
    string,
    DockerRegistry
  >,
> {
  /**
   * Whether to pull the image.
   * @default true
   */
  enabled?: boolean;

  /**
   * Always pull the image. Takes precedence over `policy`. But is preceded by
   * `build.force` or build policy `'always'`.
   * @default false
   */
  force?: boolean;

  /**
   * Keep the image after pulling. Only relevant when pull image differs from
   * the base image. (e.g. pull from different/mirrored registry)
   * @default true
   */
  keep?: boolean;

  policy?: ImagePullPolicyShorthand;

  /**
   * Override the full image reference to use when pulling the image.
   */
  ref?: string;

  /**
   * Override the tag to use when pulling the image. Takes precedence over `ref`.
   */
  tag?: string;

  /**
   * Override the repository to use when pulling the image. Takes precedence over `ref`.
   */
  repository?: string;

  /**
   * Override the digest to use when pulling the image. Takes precedence over `ref`.
   */
  digest?: string;

  /**
   * Override the registry to use when pulling the image. Takes precedence over `ref`.
   */
  registry?: DockerRegistry | (keyof Registries & string);
}

export function parsePullConfig<
  Registries extends Record<string, DockerRegistry>,
>(props: ImageProps<Registries>) {
  const policy =
    (typeof props.pull === "object"
      ? props.pull.policy
      : props.pull === true
        ? "missing"
        : props.pull === false
          ? "never"
          : props.pull) ?? "missing";

  const config: ImagePullProps<Registries> = {
    enabled: policy !== "never",
    force: policy === "always",
    keep: true,
    ...(typeof props.pull === "object" ? props.pull : {}),
  };

  return config;
}

async function pullImage<
  Registries extends Record<string, DockerRegistry>,
>(opts: {
  id: string;
  fqn: string;
  pullConfig: ImagePullProps<Registries>;
  props: ImageProps<Registries>;
  dockerHost: DockerHost;
  api: Dockerode;
  ref: ImageRef;
}) {
  const { id, fqn, api, ref, pullConfig, dockerHost } = opts;

  const [pullRef, registryAuth] = getRegistryAuth(ref, dockerHost.registries, {
    ref: pullConfig.ref,
    repository: pullConfig.repository,
    tag: pullConfig.tag,
    digest: pullConfig.digest,
    registry: pullConfig.registry,
  });

  logger.task(fqn, {
    prefix: "pulling",
    prefixColor: "yellowBright",
    resource: id,
    message: `Pulling image ${pullRef.fqn}`,
    status: "pending",
  });

  return new Promise<ImageInspectInfo>((resolve, reject) => {
    api.pull(
      pullRef.fqn,
      {
        authconfig: registryAuth ? { base64: registryAuth } : undefined,
      },
      (err, stream) => {
        if (err) return reject(err);

        const onFinished = async (err: any) => {
          if (err) return reject(err);

          logger.task(fqn, {
            prefix: "tagging",
            prefixColor: "greenBright",
            resource: id,
            message: `Tagging pulled image as ${ref.fqn}`,
            status: "pending",
          });
          await api.getImage(pullRef.fqn).tag({ repo: ref.fqn });

          // In some cases when pulling from a different registry, the user
          // may not want to keep the image after pulling.
          if (!pullConfig.keep && pullRef.fqn !== ref.fqn) {
            logger.task(fqn, {
              prefix: "removing",
              prefixColor: "redBright",
              resource: id,
              message: `Removing temporary image ${pullRef.fqn}`,
              status: "pending",
            });
            await api.getImage(pullRef.fqn).remove();
          }

          return resolve(await api.getImage(ref.fqn).inspect());
        };
        const onProgress = (event: any) => {
          if (!event.status) return;

          logger.task(fqn, {
            prefix: "pulling",
            prefixColor: "yellowBright",
            resource: `${id}${event.id ? ` (${event.id})` : ""}`,
            message: `${event.status} ${event.progress || ""}`,
            status: "pending",
          });
        };

        api.modem.followProgress(stream!, onFinished, onProgress);
      },
    );
  });
}

// -----------------------------------------------------------------------------
// Pushing
// -----------------------------------------------------------------------------

export type ImagePushPolicyShorthand = "missing" | "always" | "never";
export interface ImagePushProps<
  Registries extends Record<string, DockerRegistry> = Record<
    string,
    DockerRegistry
  >,
> {
  /**
   * Whether to push the image.
   * @default false
   */
  enabled?: boolean;

  /**
   * Always push the image. Takes precedence over `policy`.
   * @default false
   */
  force?: boolean;

  /**
   * Keep the image after pushing. Only relevant when push image differs from
   * the base image. (e.g. push to different/mirrored registry)
   *
   * If push and pull images are the same, pull.keep takes precedence if set.
   * @default true
   */
  keep?: boolean;

  policy?: ImagePushPolicyShorthand;

  /**
   * Override the full image reference to use when pulling the image.
   */
  ref?: string;

  /**
   * Override the tag to use when pulling the image. Takes precedence over `ref`.
   */
  tag?: string;

  /**
   * Override the repository to use when pulling the image. Takes precedence over `ref`.
   */
  repository?: string;

  /**
   * Override the registry to pull from.
   */
  registry?: DockerRegistry | (keyof Registries & string);

  /**
   * Fail if the image digest does not match the remote image digest.
   * If `force` is set to `true` or `policy` is set to `always`, this option is ignored.
   * @default false
   */
  failOnDigestMismatch?: boolean;
}

export function parsePushConfig<
  Registries extends Record<string, DockerRegistry>,
>(props: ImageProps<Registries>) {
  const policy =
    (typeof props.push === "object"
      ? props.push.policy || "missing"
      : props.push === true
        ? "missing"
        : props.push === false
          ? "never"
          : props.push) ?? "never";

  const config: ImagePushProps<Registries> = {
    enabled: policy !== "never",
    force: policy === "always",
    keep: true,
    failOnDigestMismatch: false,
    ...(typeof props.push === "object" ? props.push : {}),
  };

  return config;
}

async function pushImage<
  Registries extends Record<string, DockerRegistry>,
>(opts: {
  id: string;
  fqn: string;
  pushConfig: ImagePushProps<Registries>;
  props: ImageProps<Registries>;
  dockerHost: DockerHost;
  api: Dockerode;
  ref: ImageRef;
}) {
  const { id, fqn, api, ref, pushConfig, dockerHost } = opts;

  const [pushRef, registryAuth] = getRegistryAuth(ref, dockerHost.registries, {
    ref: pushConfig.ref,
    repository: pushConfig.repository,
    tag: pushConfig.tag,
    registry: pushConfig.registry,
  });

  const localImage = await api.getImage(ref.fqn).inspect();

  const remoteImage = await api
    .getImage(pushRef.fqn)
    // @ts-expect-error dockerode types are incorrect
    .distribution({
      authconfig: registryAuth ? { base64: registryAuth } : undefined,
    })
    .catch((err) => {
      if (/manifest unknown/.test(err.message)) {
        return null;
      }

      throw err;
    });

  if (remoteImage && !pushConfig.force) {
    const digestMatches = localImage.RepoDigests.some((digest) =>
      digest.endsWith(remoteImage.Descriptor.digest),
    );
    if (!digestMatches) {
      if (pushConfig.failOnDigestMismatch) {
        throw new Error(
          `Image ${pushRef.fqn} already exists in remote registry. But with different digest.`,
        );
      }

      logger.task(fqn, {
        prefix: "pushed",
        prefixColor: "yellowBright",
        resource: id,
        message: `Image ${pushRef.fqn} already exists in remote registry. But with different digest.`,
        status: "success",
      });
      return remoteImage;
    }

    logger.task(fqn, {
      prefix: "pushed",
      prefixColor: "yellowBright",
      resource: id,
      message: `Image ${pushRef.fqn} already exists in remote registry. Skipping push.`,
      status: "success",
    });
    return;
  }

  logger.task(fqn, {
    prefix: "tagging",
    prefixColor: "yellowBright",
    resource: id,
    message: `Tagging push image as ${pushRef.fqn}`,
    status: "pending",
  });
  await api.getImage(ref.fqn).tag({ repo: pushRef.fqn });

  logger.task(fqn, {
    prefix: "pushing",
    prefixColor: "yellowBright",
    resource: id,
    message: `Pushing image ${pushRef.fqn}`,
    status: "pending",
  });

  return new Promise<ImageInspectInfo>((resolve, reject) => {
    api.getImage(pushRef.fqn).push(
      {
        // @ts-expect-error
        authconfig: registryAuth ? { base64: registryAuth } : undefined,
      },
      (err, stream) => {
        if (err) return reject(err);

        const onFinished = async (err: any) => {
          if (err) return reject(err);

          // In some cases when pushing to a different registry, the user
          // may not want to keep the image after pulling.
          if (!pushConfig.keep && pushRef.fqn !== ref.fqn) {
            logger.task(fqn, {
              prefix: "removing",
              prefixColor: "redBright",
              resource: id,
              message: `Removing temporary image ${pushRef.fqn}`,
              status: "pending",
            });
            await api.getImage(pushRef.fqn).remove();
          }

          return resolve(await api.getImage(ref.fqn).inspect());
        };
        const onProgress = (event: any) => {
          if (!event.status) return;

          logger.task(fqn, {
            prefix: "pushing",
            prefixColor: "yellowBright",
            resource: `${id}${event.id ? ` (${event.id})` : ""}`,
            message: `${event.status} ${event.progress || ""}`,
            status: "pending",
          });
        };

        api.modem.followProgress(stream!, onFinished, onProgress);
      },
    );
  });
}

// -----------------------------------------------------------------------------
// Building
// -----------------------------------------------------------------------------

export type ImageBuildPolicyShorthand = "missing" | "always" | "never";
export interface ImageBuildProps {
  /**
   * Whether to build the image.
   * @default true
   */
  enabled?: boolean;

  /**
   * Always build the image. Takes precedence over `policy`.
   * @default false
   */
  force?: boolean;

  /**
   * Build policy
   * @default missing
   */
  policy?: ImageBuildPolicyShorthand;

  /**
   * Path to the build context directory
   * @default process.cwd()
   */
  context?: string;

  /**
   * Path within the build context to the Dockerfile.
   * @default Dockerfile
   */
  dockerfile?: string;

  /**
   * Build arguments
   * @default {}
   */
  args?: Record<string, string>;

  /**
   * Target build stage in multi-stage builds
   * @default undefined
   */
  target?: string;

  /**
   * Platform in the format os[/arch[/variant]]
   * @todo Only the first platform will be used, keeping array for future
   * implementation.
   * @default []
   */
  platforms?: string[];

  /**
   * Extra hosts to add to /etc/hosts
   * @default {}
   */
  extraHosts?: Record<string, string>;

  /**
   * Labels to add to the image
   * @default {}
   */
  labels?: Record<string, string>;

  /**
   * Suppress verbose build output.
   * @default false
   */
  quiet?: boolean;

  /**
   * Cache control.
   * - `boolean`: Whether to use the cache or not.
   * - `string[]`: Array of images used for build cache resolution.
   * @default false
   */
  cache?: false | string[];

  /**
   * Attempt to pull the image even if an older image exists locally.
   * @default false
   */
  alwaysPullBaseImage?: boolean;

  /**
   * Remove intermediate containers after a successful build.
   * - `true`: Remove intermediate containers after a successful build.
   * - `false`: Keep intermediate containers.
   * - `'always'`: Always remove intermediate containers, even upon failure.
   * @default true
   */
  removeIntermediateContainers?: boolean | "always";

  /**
   * Squash the resulting images layers into a single layer.
   * (Only supported on experimental releases)
   * @default false
   */
  squash?: boolean;

  /**
   * Sets the networking mode for the run commands during build.
   * Supported standard values are: bridge, host, none, and container:<name|id>.
   * Any other value is taken as a custom network's name or ID to which this container should connect to.
   */
  networkMode?: "host" | "none" | "bridge" | (string & {});

  /**
   * Configure memory limits for the build container.
   */
  memory?: {
    /**
     * Set memory limit for build can be a number or a string with a unit.
     * @example "1gb", "1024mb", 1024 * 1024 * 1024
     */
    limit: number | string;

    /**
     * Amount of swap for the build.
     * - `0` to disable swap.
     * - `-1` to enable unlimited swap.
     * @example "1gb", "1024mb", 1024 * 1024 * 1024
     * @default -1
     */
    swap?: number | string;
  };

  cpu?: {
    /**
     * The length of a CPU period in microseconds.
     *
     * Docker CLI Equivalent: `--cpu-period`
     * @default 100000 // (100ms)
     */
    period?: number;

    /**
     * The number of microseconds per `cpu.period` that the container is limited
     * to before being throttled. As such acting as the effective ceiling.
     *
     * Docker CLI Equivalent: `--cpu-quota`
     * @default -1 (unlimited)
     */
    quota?: number;

    /**
     * Set this flag to a value greater or less than the default of 1024 to increase
     * or reduce the container's weight, and give it access to a greater or lesser
     * proportion of the host machine's CPU cycles. This is only enforced when CPU
     * cycles are constrained. When plenty of CPU cycles are available, all
     * containers use as much CPU as they need.
     *
     * In that way, this is a soft limit. `cpu.shares` doesn't prevent containers
     * from being scheduled in Swarm mode. It prioritizes container CPU resources
     * for the available CPU cycles. It doesn't guarantee or reserve any specific
     * CPU access.
     *
     * Docker CLI Equivalent: `--cpu-shares`
     * @default 1024
     */
    shares?: number;

    /**
     * CPUs in which to allow execution.
     * @example "0-3", "0,1"
     * @default undefined
     */
    cpuset?: string;
  };

  /**
   * IPC Configuration for the build container.
   */
  ipc?: {
    /**
     * Size of `/dev/shm` on the build container.
     * @example "1gb", "1024mb", 1024 * 1024 * 1024
     * @default "64mb"
     */
    shmSize?: number | string;
  };
}

function parseBuildConfig<Registries extends Record<string, DockerRegistry>>(
  props: ImageProps<Registries>,
) {
  const policy =
    (typeof props.build === "object"
      ? props.build.policy || "missing"
      : props.build === true
        ? "missing"
        : props.build === false
          ? "never"
          : props.build) ?? "never";

  const config = {
    enabled: policy !== "never",
    force: policy === "always",
    context: ".",
    ...(typeof props.build === "object" ? props.build : {}),
  } satisfies ImageBuildProps;

  if (props.build === undefined) {
    return config;
  }

  // Docker file resolution
  if (!config.dockerfile) {
    config.dockerfile = tryFiles([
      path.join(config.context, "Dockerfile"),
      path.join(config.context, "dockerfile"),
    ]);
    if (!config.dockerfile) {
      throw new Error(
        `Dockerfile not found in build context: ${config.context}`,
      );
    }
    config.dockerfile = path.relative(config.context, config.dockerfile);
  } else if (
    path
      .relative(config.context, path.join(config.context, config.dockerfile))
      .startsWith("..")
  ) {
    // TODO: This should be supported somehow as docker build does support this.
    // Maybe with the `remote` option and a data url?
    throw new Error(
      `Dockerfile outside build context not supported: ${config.dockerfile}`,
    );
  }

  if (typeof config.memory?.limit === "string") {
    config.memory.limit = parseBytes(config.memory.limit);
  }

  if (typeof config.memory?.swap === "string") {
    config.memory.swap = parseBytes(config.memory.swap);
  }

  if (typeof config.ipc?.shmSize === "string") {
    config.ipc.shmSize = parseBytes(config.ipc.shmSize);
  }

  return config;
}

async function buildImage<
  Registries extends Record<string, DockerRegistry>,
>(opts: {
  id: string;
  fqn: string;
  buildConfig: ImageBuildProps;
  props: ImageProps<Registries>;
  dockerHost: DockerHost;
  api: Dockerode;
  ref: ImageRef;
}) {
  const { id, fqn, api, ref, dockerHost, buildConfig } = opts;
  const context = buildConfig.context ?? ".";

  const extraHosts = Object.entries(buildConfig.extraHosts ?? {}).map(
    ([host, ip]) => `${host}:${ip}`,
  );

  logger.task(fqn, {
    prefix: "building",
    prefixColor: "yellowBright",
    resource: id,
    message: "Generating build context",
    status: "pending",
  });

  let filterFn: ((path: string) => boolean) | undefined;
  let ignoreFn: ((path: string) => boolean) | undefined;
  if (existsSync(path.join(context, ".dockerignore"))) {
    const dockerIgnore = dockerIgnoreBuilder({ ignorecase: false });
    dockerIgnore.add(
      fs.readFileSync(path.join(context, ".dockerignore"), "utf-8"),
    );
    filterFn = dockerIgnore.createFilter();
    ignoreFn = (path) => !filterFn!(path);
  }

  let size = 0;
  let count = 0;
  const tarStream = tar
    .pack(context, {
      ignore: ignoreFn,
      filter: filterFn,
      map(header) {
        readline.moveCursor(process.stdout, 0, -1);
        readline.clearLine(process.stdout, 1);
        logger.task(fqn, {
          prefix: "building",
          prefixColor: "yellowBright",
          resource: id,
          message: `Generating build context (${formatBytes(size)}, ${count} files)`,
          status: "pending",
        });
        size += header.size ?? 0;
        count++;
        return header;
      },
      finish: () => {
        readline.moveCursor(process.stdout, 0, -1);
        readline.clearLine(process.stdout, 1);
        logger.task(fqn, {
          prefix: "building",
          prefixColor: "yellowBright",
          resource: id,
          message: `Generated build context (${formatBytes(size)}, ${count} files)`,
          status: "success",
        });
      },
    })
    .pipe(zlib.createGzip());

  const registryconfig: Dockerode.RegistryConfig = {};
  for (const registry of Object.values(dockerHost.registries)) {
    registryconfig[registry.server] = {
      username: registry.username ?? "",
      password: registry.password?.unencrypted ?? "",
    };
  }

  const buildcfg: Dockerode.ImageBuildOptions = {
    t: ref.fqn,
    dockerfile: buildConfig.dockerfile,
    target: buildConfig.target,
    labels: buildConfig.labels,
    buildargs: buildConfig.args,
    platform: buildConfig.platforms?.[0],
    q: buildConfig.quiet,
    nocache: buildConfig.cache === false,
    pull: buildConfig.alwaysPullBaseImage,
    registryconfig: registryconfig,
    rm: buildConfig.removeIntermediateContainers !== false,
    forcerm: buildConfig.removeIntermediateContainers === "always",
    squash: buildConfig.squash,
    networkmode: buildConfig.networkMode,
    // @ts-expect-error dockerode types are incorrect, should be string
    cpusetcpus: buildConfig.cpu?.cpuset as number,
    cpuperiod: buildConfig.cpu?.period,
    cpuquota: buildConfig.cpu?.quota,
    cpushares: buildConfig.cpu?.shares,
  };

  if (extraHosts.length > 0) {
    buildcfg.extrahosts =
      extraHosts as any as string; /* dockerode types are incorrect */
  }

  if (typeof buildConfig.memory?.limit === "number") {
    buildcfg.memory = buildConfig.memory.limit;
    if (buildConfig.memory.swap === -1) {
      buildcfg.memswap = -1;
    } else if (Number(buildConfig.memory.swap) > -1) {
      buildcfg.memswap =
        buildConfig.memory.limit + Number(buildConfig.memory.swap);
    }
  }

  if (typeof buildConfig.ipc?.shmSize === "number") {
    buildcfg.shmsize = buildConfig.ipc.shmSize;
  }

  const buildStream = await api.buildImage(tarStream, buildcfg);
  await new Promise((resolve, reject) => {
    const onFinished = async (err: any) => {
      if (err) return reject(err);
      resolve(await api.getImage(ref.fqn).inspect());
    };
    const onProgress = (evt: any) => {
      // The stream sends JSON with fields like { id, status, stream, error, progress, aux }
      if (evt.error) {
        reject(`Error building image: ${evt.error}`);
        return;
      }

      // Docker/BuildKit often uses evt.id (step/vertex) + status/progress
      const key: string = evt.id || "build";
      const msg =
        evt.stream ??
        [evt.status, evt.progress?.startsWith("[") ? evt.progress : undefined]
          .filter(Boolean)
          .join(" ");

      if (!msg || msg.trim() === "") return;

      logger.task(fqn, {
        prefix: "building",
        prefixColor: "yellowBright",
        resource: `${id} (${key})`,
        message: msg.replace(/\n$/, ""),
        status: "pending",
      });
    };

    api.modem.followProgress(buildStream, onFinished, onProgress);
  });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getRegistryAuth<Registries extends Record<string, DockerRegistry>>(
  ref: ImageRef,
  registries: Registries,
  overrides: {
    ref?: string;
    repository?: string;
    digest?: string;
    tag?: string;
    registry?: DockerRegistry | (keyof Registries & string);
  },
): [ImageRef, string | undefined] {
  const imageRef = parseImageRef(ref.fqn);
  const registryAuth = Object.values<DockerRegistry>(registries)
    .find((registry) => registry.server === ref.registry)
    ?.toBase64();

  if (overrides.ref) {
    imageRef.fqn = overrides.ref;
  }

  if (overrides.repository) {
    imageRef.repository = overrides.repository;
  }

  if (overrides.digest) {
    imageRef.digest = overrides.digest;
  }

  if (overrides.tag) {
    imageRef.tag = overrides.tag;
  }

  if (overrides.registry) {
    if (typeof overrides.registry === "string") {
      if (overrides.registry in registries) {
        imageRef.registry = registries[overrides.registry].server;
        return [imageRef, registries[overrides.registry].toBase64()];
      } else {
        throw new Error(
          `Registry ${overrides.registry} not bound to docker host`,
        );
      }
    } else {
      imageRef.registry = overrides.registry.server;
      return [imageRef, overrides.registry.toBase64()];
    }
  }

  return [imageRef, registryAuth];
}

export interface ImageRef {
  registry: string;
  repository: string;
  tag: string | undefined;
  digest: string | undefined;
  fqn: string;
}

export function parseImageRef(ref: string) {
  const segments = ref.split("/");
  const image = {
    registry: "docker.io",
    get fqn() {
      return `${this.registry}/${this.repository}${this.tag ? `:${this.tag}` : ""}${this.digest ? `@${this.digest}` : ""}`;
    },
    set fqn(value: string) {
      const parsed = parseImageRef(value);
      this.registry = parsed.registry;
      this.repository = parsed.repository;
      this.tag = parsed.tag;
      this.digest = parsed.digest;
    },
  } as ImageRef;

  // parse registry
  if (segments.length === 1) {
    image.repository = `library/${segments[0]}`;
  } else if (segments.length > 1) {
    if (/\.|:\d+|^(localhost|\d+\.\d+\.\d+\.\d+)$/.test(segments[0])) {
      image.registry = segments[0];
      if (["docker.io", "index.docker.io"].includes(image.registry)) {
        image.registry = "docker.io";
      }

      if (segments.length === 2 && image.registry === "docker.io") {
        image.repository = `library/${segments[1]}`;
      } else {
        image.repository = segments.slice(1).join("/");
      }
    } else {
      image.repository = segments.join("/");
    }
  }

  // parse tag and digest
  if (!image.repository)
    throw new Error(
      `Invalid image reference: ${ref}. No repository part found.`,
    );
  if (image.repository.includes("@")) {
    [image.repository, image.digest] = image.repository.split("@");
    if (!image.digest.includes(":")) {
      throw new Error(`Invalid image reference: ${ref}. No digest part found.`);
    }

    const [algorithm, hash] = image.digest.split(":");
    if (!algorithm || !hash) {
      throw new Error(
        `Invalid image reference: ${ref}. No algorithm or hash part found.`,
      );
    }
  }

  if (image.repository.includes(":")) {
    [image.repository, image.tag] = image.repository.split(":");
    if (!image.tag) {
      throw new Error(`Invalid image reference: ${ref}. No tag part found.`);
    }
  } else if (!image.digest) {
    image.tag = "latest";
  }

  return image;
}

function tryFiles(filenames: string[]): string | undefined {
  for (const filename of filenames) {
    if (existsSync(filename)) {
      return filename;
    }
  }

  return undefined;
}
