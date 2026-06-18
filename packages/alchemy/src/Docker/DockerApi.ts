import {
  DockerCommandError,
  dockerLogin,
  dockerTag,
  getDockerImageId,
  runDockerCommand,
  type RegistryAuth,
} from "../Bundle/Docker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

export { DockerCommandError, runDockerCommand };

export type SecretString = string | Redacted.Redacted<string>;

export type Duration = number | `${number}${"ms" | "s" | "m" | "h"}`;

export interface DockerCommandSpec {
  readonly args: ReadonlyArray<string>;
  readonly env?: Record<string, string | undefined>;
}

export interface VolumeInfo {
  CreatedAt: string;
  Driver: string;
  Labels: Record<string, string> | null;
  Mountpoint: string;
  Name: string;
  Options: Record<string, string> | null;
  Scope: string;
}

export interface NetworkInfo {
  Name: string;
  Id: string;
  Created: string;
  Scope: string;
  Driver: string;
  EnableIPv6: boolean;
  Labels: Record<string, string> | null;
}

export type ContainerStatus =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "removing"
  | "exited"
  | "dead";

export interface ContainerInfo {
  Id: string;
  Name?: string;
  State: { Status: ContainerStatus };
  Created: string;
  Config: {
    Image: string;
    Cmd: string[] | null;
    Env: string[] | null;
    Healthcheck?: {
      Test: string[] | null;
      Interval?: number;
      Timeout?: number;
      Retries?: number;
      StartPeriod?: number;
      StartInterval?: number;
    } | null;
  };
  HostConfig: {
    PortBindings: Record<
      string,
      Array<{ HostIp: string; HostPort: string }> | null
    > | null;
    Binds: string[] | null;
    RestartPolicy: {
      Name: string;
      MaximumRetryCount: number;
    };
    AutoRemove: boolean;
  };
  NetworkSettings: {
    Networks: Record<
      string,
      {
        NetworkID: string;
        Aliases: string[] | null;
      }
    > | null;
    Ports?: Record<
      string,
      Array<{ HostIp: string; HostPort: string }> | null
    > | null;
  };
}

export interface ImageInspectInfo {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
}

export interface ContainerRuntimeInfo {
  /**
   * Map of internal container ports to their bound host ports.
   * Format: `"80/tcp" -> 8080`.
   */
  ports: Record<string, number>;
}

export interface PortMapping {
  /** External port on the host. */
  external: number | string;
  /** Internal port inside the container. */
  internal: number | string;
  /** Protocol used for the mapping. @default "tcp" */
  protocol?: "tcp" | "udp";
}

export interface VolumeMapping {
  /** Host path or named volume source. */
  hostPath: string;
  /** Container path. */
  containerPath: string;
  /** Mount read-only. @default false */
  readOnly?: boolean;
}

export interface NetworkMapping {
  /** Network name or ID. */
  name: string;
  /** Network aliases for the container. */
  aliases?: string[];
}

export interface HealthcheckConfig {
  /** Command to run for health checks. */
  cmd: string[] | string;
  /** Time between checks. */
  interval?: Duration;
  /** Maximum time a check may run. */
  timeout?: Duration;
  /** Consecutive failures before unhealthy. */
  retries?: number;
  /** Startup grace period. */
  startPeriod?: Duration;
  /** Check interval during startup. Requires Docker API 1.44+. */
  startInterval?: Duration;
}

export interface ContainerCreateOptions {
  image: string;
  name: string;
  command?: string[];
  environment?: Record<string, SecretString>;
  ports?: PortMapping[];
  volumes?: VolumeMapping[];
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  removeOnExit?: boolean;
  healthcheck?: HealthcheckConfig;
}

export interface DockerBuildCommandOptions {
  tag: string;
  context: string;
  dockerfile?: string;
  platform?: string;
  target?: string;
  args?: Record<string, string>;
  cacheFrom?: string[];
  cacheTo?: string[];
  options?: string[];
}

export interface RegistryPushCredentials {
  server: string;
  username: string;
  password: SecretString;
}

export const unwrapSecretString = (value: SecretString): string =>
  typeof value === "string" ? value : Redacted.value(value);

export function normalizeDuration(duration: Duration): string {
  if (typeof duration === "number") {
    return `${duration}s`;
  }
  if (!/^(\d+(?:\.\d+)?)(ms|s|m|h)$/.test(duration)) {
    throw new Error(
      `Invalid duration format: "${duration}". Expected number followed by ms, s, m, or h.`,
    );
  }
  return duration;
}

export function durationToNanoseconds(duration: Duration | undefined): number {
  if (duration === undefined) return 0;
  const normalized = normalizeDuration(duration);
  const match = normalized.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) return 0;
  const value = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return value * 1_000_000;
    case "s":
      return value * 1_000_000_000;
    case "m":
      return value * 60 * 1_000_000_000;
    case "h":
      return value * 60 * 60 * 1_000_000_000;
    default:
      return 0;
  }
}

export const normalizeLabels = (
  labels:
    | Record<string, string>
    | ReadonlyArray<{ name: string; value: string }>
    | undefined,
): Record<string, string> => {
  if (!labels) return {};
  const value = labels as
    | Record<string, string>
    | ReadonlyArray<{ name: string; value: string }>;
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((label) => [label.name, label.value]));
  }
  return { ...(value as Record<string, string>) };
};

export const buildVolumeCreateArgs = (input: {
  name: string;
  driver?: string;
  driverOpts?: Record<string, string>;
  labels?: Record<string, string>;
}): string[] => {
  const args = [
    "volume",
    "create",
    "--name",
    input.name,
    "--driver",
    input.driver ?? "local",
  ];
  for (const [key, value] of Object.entries(input.driverOpts ?? {})) {
    args.push("--opt", `${key}=${value}`);
  }
  for (const [key, value] of Object.entries(input.labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }
  return args;
};

export const buildNetworkCreateArgs = (input: {
  name: string;
  driver?: string;
  enableIPv6?: boolean;
  labels?: Record<string, string>;
}): string[] => {
  const args = ["network", "create", "--driver", input.driver ?? "bridge"];
  if (input.enableIPv6) {
    args.push("--ipv6");
  }
  for (const [key, value] of Object.entries(input.labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }
  args.push(input.name);
  return args;
};

export const buildImageBuildArgs = (
  options: DockerBuildCommandOptions,
): string[] => {
  const args = ["build", "-t", options.tag];
  if (options.platform) args.push("--platform", options.platform);
  if (options.target) args.push("--target", options.target);
  for (const source of options.cacheFrom ?? []) {
    args.push("--cache-from", source);
  }
  for (const target of options.cacheTo ?? []) {
    args.push("--cache-to", target);
  }
  for (const [key, value] of Object.entries(options.args ?? {})) {
    args.push("--build-arg", `${key}=${value}`);
  }
  if (options.options?.length) {
    args.push(...options.options);
  }
  if (options.dockerfile) {
    args.push("-f", options.dockerfile);
  }
  args.push(options.context);
  return args;
};

export const buildContainerCreateCommand = (
  options: ContainerCreateOptions,
): DockerCommandSpec => {
  const args = ["create", "--name", options.name];
  const env: Record<string, string | undefined> = {};

  for (const port of options.ports ?? []) {
    const protocol = port.protocol ?? "tcp";
    args.push("-p", `${port.external}:${port.internal}/${protocol}`);
  }

  for (const [key, value] of Object.entries(options.environment ?? {})) {
    // `--env KEY` reads the value from the child process environment, so
    // Redacted secrets are never embedded in argv or DockerCommandError.command.
    args.push("--env", key);
    env[key] = unwrapSecretString(value);
  }

  for (const volume of options.volumes ?? []) {
    const readOnly = volume.readOnly ? ":ro" : "";
    args.push("-v", `${volume.hostPath}:${volume.containerPath}${readOnly}`);
  }

  if (options.restart) {
    args.push("--restart", options.restart);
  }
  if (options.removeOnExit) {
    args.push("--rm");
  }

  if (options.healthcheck) {
    const healthcheck = options.healthcheck;
    args.push(
      "--health-cmd",
      Array.isArray(healthcheck.cmd)
        ? healthcheck.cmd.join(" ")
        : healthcheck.cmd,
    );
    if (healthcheck.interval !== undefined) {
      args.push("--health-interval", normalizeDuration(healthcheck.interval));
    }
    if (healthcheck.timeout !== undefined) {
      args.push("--health-timeout", normalizeDuration(healthcheck.timeout));
    }
    if (healthcheck.retries !== undefined) {
      args.push("--health-retries", String(healthcheck.retries));
    }
    if (healthcheck.startPeriod !== undefined) {
      args.push(
        "--health-start-period",
        normalizeDuration(healthcheck.startPeriod),
      );
    }
    if (healthcheck.startInterval !== undefined) {
      args.push(
        "--health-start-interval",
        normalizeDuration(healthcheck.startInterval),
      );
    }
  }

  args.push(options.image);
  if (options.command?.length) {
    args.push(...options.command);
  }

  return {
    args,
    env: Object.keys(env).length ? env : undefined,
  };
};

export const toRuntimeInfo = (info: ContainerInfo): ContainerRuntimeInfo => {
  const ports: Record<string, number> = {};

  for (const [internal, bindings] of Object.entries(
    info.NetworkSettings.Ports ?? {},
  )) {
    const hostPort = bindings?.[0]?.HostPort;
    if (hostPort) ports[internal] = Number.parseInt(hostPort, 10);
  }

  for (const [internal, bindings] of Object.entries(
    info.HostConfig.PortBindings ?? {},
  )) {
    const hostPort = bindings?.[0]?.HostPort;
    if (hostPort && !(internal in ports)) {
      ports[internal] = Number.parseInt(hostPort, 10);
    }
  }

  return { ports };
};

export const parseRepoDigest = (
  imageRef: string,
  output: string,
): string | undefined => {
  const match = /digest:\s+([a-z0-9]+:[a-f0-9]{64})/i.exec(output);
  if (!match) return undefined;
  return `${repositoryFromImageRef(imageRef)}@${match[1]}`;
};

export const repositoryFromImageRef = (imageRef: string): string => {
  const withoutDigest = imageRef.includes("@")
    ? imageRef.slice(0, imageRef.indexOf("@"))
    : imageRef;
  const tagSeparator = withoutDigest.lastIndexOf(":");
  const pathSeparator = withoutDigest.lastIndexOf("/");
  return tagSeparator > pathSeparator
    ? withoutDigest.slice(0, tagSeparator)
    : withoutDigest;
};

export const withRegistryHost = (
  imageRef: string,
  registry: Pick<RegistryPushCredentials, "server">,
): string => {
  const registryHost = registry.server.replace(/\/$/, "");
  const firstSegment = imageRef.split("/")[0];
  const hasRegistryPrefix =
    imageRef.includes("/") &&
    (firstSegment.includes(".") ||
      firstSegment.includes(":") ||
      firstSegment === "localhost");
  return hasRegistryPrefix ? imageRef : `${registryHost}/${imageRef}`;
};

const catchMissing = <A>(
  effect: Effect.Effect<A, DockerCommandError, any>,
): Effect.Effect<A | undefined, DockerCommandError, any> =>
  effect.pipe(
    Effect.catchIf(
      (error) =>
        /No such|not found|No such object|No such image|No such container/i.test(
          error.message,
        ),
      () => Effect.succeed(undefined),
    ),
  );

export const inspectJson = <A>(
  args: ReadonlyArray<string>,
): Effect.Effect<A | undefined, DockerCommandError, any> =>
  catchMissing(
    runDockerCommand(args).pipe(
      Effect.map(({ stdout }) => JSON.parse(stdout.trim()) as A),
    ),
  );

export const inspectVolume = (name: string) =>
  inspectJson<VolumeInfo[]>(["volume", "inspect", name]).pipe(
    Effect.map((volumes) => volumes?.[0]),
  );

export const inspectNetwork = (name: string) =>
  inspectJson<NetworkInfo[]>(["network", "inspect", name]).pipe(
    Effect.map((networks) => networks?.[0]),
  );

export const inspectContainer = (name: string) =>
  inspectJson<ContainerInfo[]>(["container", "inspect", name]).pipe(
    Effect.map((containers) => containers?.[0]),
  );

export const inspectImage = (imageRef: string) =>
  inspectJson<ImageInspectInfo[]>(["image", "inspect", imageRef]).pipe(
    Effect.map((images) => images?.[0]),
  );

export const createVolume = Effect.fn(function* (input: {
  name: string;
  driver?: string;
  driverOpts?: Record<string, string>;
  labels?: Record<string, string>;
}) {
  const { stdout } = yield* runDockerCommand(buildVolumeCreateArgs(input));
  return stdout.trim();
});

export const createNetwork = Effect.fn(function* (input: {
  name: string;
  driver?: string;
  enableIPv6?: boolean;
  labels?: Record<string, string>;
}) {
  const { stdout } = yield* runDockerCommand(buildNetworkCreateArgs(input));
  return stdout.trim();
});

export const removeNetwork = (id: string) =>
  runDockerCommand(["network", "rm", id]).pipe(
    Effect.catchIf(
      (error) => /No such network|not found/i.test(error.message),
      () => Effect.void,
    ),
  );

export const removeVolume = (name: string) =>
  runDockerCommand(["volume", "rm", name]).pipe(
    Effect.catchIf(
      (error) => /No such volume|not found/i.test(error.message),
      () => Effect.void,
    ),
    Effect.asVoid,
  );

export const removeContainer = (name: string, force = false) =>
  runDockerCommand(["rm", ...(force ? ["-f"] : []), name]).pipe(
    Effect.catchIf(
      (error) => /No such container|not found/i.test(error.message),
      () => Effect.void,
    ),
    Effect.asVoid,
  );

export const stopContainer = (name: string) =>
  runDockerCommand(["stop", name]).pipe(
    Effect.catchIf(
      (error) =>
        /No such container|not running|is not running/i.test(error.message),
      () => Effect.void,
    ),
    Effect.asVoid,
  );

export const startContainer = (name: string) =>
  runDockerCommand(["start", name]).pipe(Effect.asVoid);

export const connectNetwork = (container: string, network: NetworkMapping) => {
  const args = ["network", "connect"];
  for (const alias of network.aliases ?? []) {
    args.push("--alias", alias);
  }
  args.push(network.name, container);
  return runDockerCommand(args).pipe(Effect.asVoid);
};

export const disconnectNetwork = (container: string, network: string) =>
  runDockerCommand(["network", "disconnect", network, container]).pipe(
    Effect.catchIf(
      (error) =>
        /is not connected|No such network|No such container/i.test(
          error.message,
        ),
      () => Effect.void,
    ),
    Effect.asVoid,
  );

export const createContainer = Effect.fn(function* (
  options: ContainerCreateOptions,
) {
  const command = buildContainerCreateCommand(options);
  const { stdout } = yield* runDockerCommand(command.args, {
    env: command.env,
  });
  return stdout.trim();
});

export const pullImage = (imageRef: string, options?: { platform?: string }) =>
  runDockerCommand([
    "pull",
    ...(options?.platform ? ["--platform", options.platform] : []),
    imageRef,
  ]).pipe(Effect.asVoid);

export const tagImage = dockerTag;

export const buildImage = (options: DockerBuildCommandOptions) =>
  runDockerCommand(buildImageBuildArgs(options), {
    cwd: options.context,
  }).pipe(Effect.asVoid);

export const imageId = getDockerImageId;

export const pushImageToRegistry = Effect.fn(function* (
  imageRef: string,
  credentials: RegistryPushCredentials,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registryHost = credentials.server.replace(/\/$/, "");
  const targetImage = withRegistryHost(imageRef, credentials);
  const configDir = yield* fs.makeTempDirectory({
    prefix: "alchemy-docker-",
  });
  const env = { DOCKER_CONFIG: configDir };
  const auth: RegistryAuth = {
    server: registryHost,
    username: credentials.username,
    password: unwrapSecretString(credentials.password),
  };

  return yield* Effect.gen(function* () {
    yield* dockerLogin(auth, { env });
    if (targetImage !== imageRef) {
      yield* dockerTag(imageRef, targetImage);
    }
    const { stdout, stderr } = yield* runDockerCommand(["push", targetImage], {
      env,
    });
    const repoDigest = parseRepoDigest(targetImage, `${stdout}\n${stderr}`);
    return {
      imageRef: targetImage,
      repoDigest,
    };
  }).pipe(
    Effect.ensuring(
      fs
        .remove(path.resolve(configDir), { recursive: true })
        .pipe(Effect.catch(() => Effect.void)),
    ),
  );
});
