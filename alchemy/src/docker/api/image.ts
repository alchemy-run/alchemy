/**
 * TODO: When an image gets rebuilt, a <none> tagged image is left dangling.
 * */

import type Dockerode from "dockerode";
import type { ImageInspectInfo } from "dockerode";
import type { Context } from "../../context.ts";
import { Resource } from "../../resource.ts";
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

/******************************************************************************
 * Building
 ******************************************************************************/
export type ImageBuildPolicyShorthand = "missing" | "always" | "never";
export interface ImageBuildProps {
  enabled?: boolean;
  context?: string;
  dockerfile?: string;
  args?: Record<string, string>;
  platforms?: string[];
}

/******************************************************************************
 * Pulling
 ******************************************************************************/
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
   * Always pull the image. Takes precedence over `policy`.
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

/******************************************************************************
 * Pushing
 ******************************************************************************/
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
    this: Context<Image>,
    _id: string,
    props: ImageProps<Registries>,
  ): Promise<Image> {
    // Initialize Docker API client
    const dockerHost = await DockerHost<Record<string, DockerRegistry>>(
      props.dockerHost,
    );
    const { dockerode: api } = dockerHost;
    let ref = parseImageRef(props.ref);

    // Parse pull config
    const pullConfig = parsePullConfig(props.pull);
    const pushConfig = parsePushConfig(props.push);

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

    // Handle image pulling and caching logic
    if (pullConfig.enabled && (pullConfig.force || !image)) {
      const pulledImage = await pullImage({
        id: this.id,
        fqn: this.fqn,
        pullConfig,
        props,
        dockerHost,
        api,
        ref,
      });

      if (pushConfig.enabled) {
        await pushImage({
          id: this.id,
          fqn: this.fqn,
          pushConfig,
          props,
          dockerHost,
          api,
          ref,
        });
      }

      return this(pulledImage);
    } else if (image) {
      logger.task(this.fqn, {
        prefix: "cached",
        prefixColor: "yellowBright",
        resource: this.id,
        message: `Image ${ref.fqn} already exists locally`,
        status: "success",
      });

      if (pushConfig.enabled) {
        await pushImage({
          id: this.id,
          fqn: this.fqn,
          pushConfig,
          props,
          dockerHost,
          api,
          ref,
        });
      }

      return this(image);
    }

    throw new Error(`Image ${ref.fqn} not found locally`);
  },
);

export function parsePullConfig<
  Registries extends Record<string, DockerRegistry>,
>(
  pull:
    | boolean
    | ImagePullPolicyShorthand
    | ImagePullProps<Registries>
    | undefined,
) {
  const policy =
    (typeof pull === "object"
      ? pull.policy
      : pull === true
        ? "missing"
        : pull === false
          ? "never"
          : pull) ?? "missing";

  const config: ImagePullProps<Registries> = {
    enabled: policy !== "never",
    force: policy === "always",
    keep: true,
  };

  return typeof pull === "object" ? { ...config, ...pull } : config;
}

export function parsePushConfig<
  Registries extends Record<string, DockerRegistry>,
>(
  push:
    | boolean
    | ImagePushPolicyShorthand
    | ImagePushProps<Registries>
    | undefined,
) {
  const policy =
    (typeof push === "object"
      ? push.policy || "missing"
      : push === true
        ? "missing"
        : push === false
          ? "never"
          : push) ?? "never";

  const config: ImagePushProps<Registries> = {
    enabled: policy !== "never",
    force: policy === "always",
    keep: true,
    failOnDigestMismatch: false,
  };

  return typeof push === "object" ? { ...config, ...push } : config;
}

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
  const { id, fqn, api, ref, props } = opts;

  const [pullRef, registryAuth] = getRegistryAuth(
    ref,
    opts.dockerHost.registries,
    {
      ref: (props?.pull as any)?.ref,
      repository: (props?.pull as any)?.repository,
      tag: (props?.pull as any)?.tag,
      digest: (props?.pull as any)?.digest,
      registry: (props?.pull as any)?.registry || props?.registry,
    },
  );

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
          if (!opts.pullConfig.keep && pullRef.fqn !== ref.fqn) {
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
  const { id, fqn, api, ref, props } = opts;

  const [pushRef, registryAuth] = getRegistryAuth(
    ref,
    opts.dockerHost.registries,
    {
      ref: (props?.push as any)?.ref,
      repository: (props?.push as any)?.repository,
      tag: (props?.push as any)?.tag,
      registry: (props?.push as any)?.registry || props?.registry,
    },
  );

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

  if (remoteImage && !opts.pushConfig.force) {
    const digestMatches = localImage.RepoDigests.some((digest) =>
      digest.endsWith(remoteImage.Descriptor.digest),
    );
    if (!digestMatches) {
      if (opts.pushConfig.failOnDigestMismatch) {
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
    prefixColor: "greenBright",
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
          if (!opts.pushConfig.keep && pushRef.fqn !== ref.fqn) {
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
