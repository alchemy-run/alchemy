import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  connectNetwork,
  createContainer,
  disconnectNetwork,
  durationToNanoseconds,
  DockerCommandError,
  inspectContainer,
  normalizeDuration,
  removeContainer,
  startContainer,
  stopContainer,
  toRuntimeInfo,
  type ContainerInfo,
  type ContainerRuntimeInfo,
  type ContainerStatus,
  type Duration,
  type HealthcheckConfig,
  type NetworkMapping,
  type PortMapping,
  type SecretString,
  type VolumeMapping,
} from "./DockerApi.ts";

export type {
  ContainerRuntimeInfo,
  ContainerStatus,
  Duration,
  HealthcheckConfig,
  NetworkMapping,
  PortMapping,
  VolumeMapping,
};

export type ContainerImage = string | { imageRef: string };

export interface ContainerProps {
  /** Image reference or Docker image resource. */
  image: ContainerImage;
  /**
   * Container name.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Command to run in the container. */
  command?: string[];
  /** Container environment variables. Use Redacted for secrets. */
  environment?: Record<string, SecretString>;
  /** Host/container port mappings. */
  ports?: PortMapping[];
  /** Volume or bind mounts. */
  volumes?: VolumeMapping[];
  /** Restart policy. */
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  /** Networks to connect after create. */
  networks?: NetworkMapping[];
  /** Remove the container when it exits. @default false */
  removeOnExit?: boolean;
  /** Start the container after creation/reconciliation. @default false */
  start?: boolean;
  /** Docker healthcheck configuration. */
  healthcheck?: HealthcheckConfig;
}

export interface Container extends Resource<
  "Docker.Container",
  ContainerProps,
  {
    /** Docker container id. */
    id: string;
    /** Docker container name. */
    name: string;
    /** Docker container state. */
    state: ContainerStatus;
    /** Creation timestamp in milliseconds since epoch. */
    createdAt: number;
    /** Image reference used to create the container. */
    imageRef: string;
  }
> {}

const inspectRuntime = (
  container: string | { name: string },
): Effect.Effect<ContainerRuntimeInfo, DockerCommandError, any> =>
  Effect.gen(function* () {
    const name = typeof container === "string" ? container : container.name;
    const info = yield* inspectContainer(name);
    if (!info) {
      return yield* Effect.fail(
        new DockerCommandError({
          command: `docker container inspect ${name}`,
          stderr: `Docker container not found: ${name}`,
          exitCode: 1,
          message: `Docker container not found: ${name}`,
        }),
      );
    }
    return toRuntimeInfo(info);
  });

/**
 * A Docker container managed through the active Docker context.
 *
 * This resource creates, starts, stops, inspects, and removes containers through
 * the Docker CLI. It is not interchangeable with `Cloudflare.Container`, which
 * manages Cloudflare's container platform; use pushed image references to bridge
 * Docker-built images into cloud container runtimes.
 *
 * @resource
 *
 * @section Running Containers
 * @example Nginx with a published port
 * ```typescript
 * const nginx = yield* Docker.Container("nginx", {
 *   image: "nginx:alpine",
 *   ports: [{ external: 8080, internal: 80 }],
 *   start: true,
 * });
 * ```
 *
 * @section Secret Environment
 * @example Redacted env var
 * ```typescript
 * const password = yield* Config.redacted("POSTGRES_PASSWORD");
 * const db = yield* Docker.Container("postgres", {
 *   image: "postgres:18-alpine",
 *   environment: {
 *     POSTGRES_PASSWORD: password,
 *   },
 *   start: true,
 * });
 * ```
 *
 * @section Networks and Volumes
 * @example PostgreSQL with persistent storage
 * ```typescript
 * const network = yield* Docker.Network("app-network");
 * const data = yield* Docker.Volume("postgres-data");
 * const postgresName = "app-postgres";
 * yield* Docker.Container("postgres", {
 *   name: postgresName,
 *   image: "postgres:18-alpine",
 *   ports: [{ external: 15432, internal: 5432 }],
 *   volumes: [{ hostPath: data.name, containerPath: "/var/lib/postgresql/data" }],
 *   networks: [{ name: network.name, aliases: ["postgres"] }],
 *   start: true,
 * });
 * const runtime = yield* Docker.Container.inspect(postgresName);
 * ```
 */
export const Container = Resource<Container>("Docker.Container")({
  inspect: inspectRuntime,
});

export const inspect = inspectRuntime;

const containerName = (id: string, props: ContainerProps, instanceId: string) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        instanceId,
        maxLength: 128,
        lowercase: true,
      });

export const imageRefOf = (image: ContainerImage): string =>
  typeof image === "string" ? image : image.imageRef;

const toContainerAttributes = (
  info: ContainerInfo,
  imageRef: string,
): Container["Attributes"] => ({
  id: info.Id,
  name: infoName(info),
  state: info.State.Status,
  createdAt: Date.parse(info.Created) || Date.now(),
  imageRef,
});

const infoName = (info: ContainerInfo) => {
  const name = info.Name;
  return typeof name === "string" ? name.replace(/^\//, "") : info.Id;
};

export const normalizeEnvironment = (
  environment: Record<string, SecretString> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment ?? {}).map(([key, value]) => [
      key,
      typeof value === "string" ? value : Redacted.value(value),
    ]),
  );

const normalizePortMappings = (
  ports: PortMapping[] | undefined,
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const port of ports ?? []) {
    map.set(`${port.external}`, `${port.internal}/${port.protocol ?? "tcp"}`);
  }
  return map;
};

const normalizeVolumeMappings = (
  volumes: VolumeMapping[] | undefined,
): Set<string> => {
  const set = new Set<string>();
  for (const volume of volumes ?? []) {
    set.add(
      `${volume.hostPath}:${volume.containerPath}${volume.readOnly ? ":ro" : ""}`,
    );
  }
  return set;
};

export const compareEnv = (
  desired: Record<string, string> | undefined,
  actual: string[] | null,
): boolean => {
  const desiredEntries = Object.entries(desired ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const actualEntries = (actual ?? [])
    .flatMap((entry) => {
      const index = entry.indexOf("=");
      return index === -1
        ? []
        : [[entry.slice(0, index), entry.slice(index + 1)] as const];
    })
    .filter(([key]) => key in (desired ?? {}))
    .sort(([a], [b]) => a.localeCompare(b));
  return deepEqual(desiredEntries, actualEntries);
};

export const comparePorts = (
  desired: PortMapping[] | undefined,
  actual: Record<
    string,
    Array<{ HostIp: string; HostPort: string }> | null
  > | null,
): boolean => {
  const desiredMap = normalizePortMappings(desired);
  const actualMap = new Map<string, string>();
  for (const [containerPort, bindings] of Object.entries(actual ?? {})) {
    const hostPort = bindings?.[0]?.HostPort;
    if (hostPort) actualMap.set(hostPort, containerPort);
  }
  return deepEqual([...desiredMap.entries()], [...actualMap.entries()]);
};

export const compareVolumes = (
  desired: VolumeMapping[] | undefined,
  actual: string[] | null,
): boolean => deepEqual([...normalizeVolumeMappings(desired)], actual ?? []);

export const compareHealthcheck = (
  desired: HealthcheckConfig | undefined,
  actual:
    | {
        Test: string[] | null;
        Interval?: number;
        Timeout?: number;
        Retries?: number;
        StartPeriod?: number;
        StartInterval?: number;
      }
    | null
    | undefined,
): boolean => {
  if (!desired) return true;
  if (!actual) return false;
  const desiredCommand = Array.isArray(desired.cmd)
    ? desired.cmd.join(" ")
    : desired.cmd;
  const actualCommand = actual.Test ? actual.Test.slice(1).join(" ") : "";
  return (
    desiredCommand === actualCommand &&
    durationToNanoseconds(desired.interval) === (actual.Interval ?? 0) &&
    durationToNanoseconds(desired.timeout) === (actual.Timeout ?? 0) &&
    (desired.retries ?? 0) === (actual.Retries ?? 0) &&
    durationToNanoseconds(desired.startPeriod) === (actual.StartPeriod ?? 0) &&
    durationToNanoseconds(desired.startInterval) === (actual.StartInterval ?? 0)
  );
};

export const compareRestartPolicy = (
  desired: ContainerProps["restart"],
  actual: ContainerInfo["HostConfig"]["RestartPolicy"],
): boolean => (desired ?? "no") === (actual?.Name || "no");

export const shouldReplaceContainer = (
  imageRef: string,
  props: ContainerProps,
  info: ContainerInfo,
): boolean => {
  if (info.Config.Image !== imageRef) return true;
  const actualCommand = info.Config.Cmd ?? [];
  if (props.command && !deepEqual(props.command, actualCommand)) return true;
  if (!compareEnv(normalizeEnvironment(props.environment), info.Config.Env)) {
    return true;
  }
  if (!comparePorts(props.ports, info.HostConfig.PortBindings)) return true;
  if (!compareVolumes(props.volumes, info.HostConfig.Binds)) return true;
  if (!compareHealthcheck(props.healthcheck, info.Config.Healthcheck)) {
    return true;
  }
  if (!compareRestartPolicy(props.restart, info.HostConfig.RestartPolicy)) {
    return true;
  }
  if ((props.removeOnExit ?? false) !== info.HostConfig.AutoRemove) {
    return true;
  }
  return false;
};

const networkChanges = (
  props: ContainerProps,
  info: ContainerInfo,
): { connect: NetworkMapping[]; disconnect: string[] } => {
  const current = info.NetworkSettings.Networks ?? {};
  const currentNames = new Set(Object.keys(current));
  const desired = new Map((props.networks ?? []).map((n) => [n.name, n]));
  const connect: NetworkMapping[] = [];
  const disconnect: string[] = [];
  for (const network of currentNames) {
    if (!desired.has(network) && network !== "bridge") {
      disconnect.push(network);
    }
  }
  for (const [name, network] of desired) {
    if (!currentNames.has(name)) {
      connect.push(network);
      continue;
    }
    const desiredAliases = network.aliases ?? [];
    const actualAliases = current[name]?.Aliases ?? [];
    if (
      name !== "bridge" &&
      desiredAliases.length > 0 &&
      !desiredAliases.every((alias) => actualAliases.includes(alias))
    ) {
      disconnect.push(name);
      connect.push(network);
    }
  }
  return { connect, disconnect };
};

const reconcileNetworksAndState = Effect.fn(function* (
  name: string,
  props: ContainerProps,
  info: ContainerInfo,
) {
  const changes = networkChanges(props, info);
  for (const network of changes.disconnect) {
    yield* disconnectNetwork(info.Id, network);
  }
  for (const network of changes.connect) {
    yield* connectNetwork(info.Id, network);
  }
  if (props.start && info.State.Status !== "running") {
    yield* startContainer(info.Id);
  }
  if (props.start === false && info.State.Status === "running") {
    yield* stopContainer(info.Id);
  }
  return yield* inspectContainer(name);
});

const createAndInspect = Effect.fn(function* (
  name: string,
  imageRef: string,
  props: ContainerProps,
) {
  const id = yield* createContainer({
    image: imageRef,
    name,
    command: props.command,
    environment: props.environment,
    ports: props.ports,
    volumes: props.volumes,
    restart: props.restart,
    removeOnExit: props.removeOnExit,
    healthcheck: props.healthcheck,
  });
  for (const network of props.networks ?? []) {
    yield* connectNetwork(id, network);
  }
  if (props.start) {
    yield* startContainer(id);
  }
  const info = yield* inspectContainer(name);
  if (!info) {
    return yield* Effect.die(
      `Docker container was created but could not be inspected: ${name}`,
    );
  }
  return info;
});

export const ContainerProvider = () =>
  Provider.succeed(Container, {
    list: () => Effect.succeed([]),
    read: Effect.fnUntraced(function* ({ id, instanceId, olds, output }) {
      const name = yield* containerName(id, olds, instanceId);
      const info = yield* inspectContainer(name);
      if (!info) return undefined;
      const attrs = toContainerAttributes(info, imageRefOf(olds.image));
      return output ? attrs : Unowned(attrs);
    }),
    diff: Effect.fnUntraced(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      const replaceShape = (props: ContainerProps) => ({
        name: props.name,
        image: imageRefOf(props.image),
        command: props.command ?? [],
        environment: normalizeEnvironment(props.environment),
        ports: props.ports ?? [],
        volumes: props.volumes ?? [],
        restart: props.restart ?? "no",
        removeOnExit: props.removeOnExit ?? false,
        healthcheck: props.healthcheck
          ? {
              ...props.healthcheck,
              interval:
                props.healthcheck.interval === undefined
                  ? undefined
                  : normalizeDuration(props.healthcheck.interval),
              timeout:
                props.healthcheck.timeout === undefined
                  ? undefined
                  : normalizeDuration(props.healthcheck.timeout),
              startPeriod:
                props.healthcheck.startPeriod === undefined
                  ? undefined
                  : normalizeDuration(props.healthcheck.startPeriod),
              startInterval:
                props.healthcheck.startInterval === undefined
                  ? undefined
                  : normalizeDuration(props.healthcheck.startInterval),
            }
          : undefined,
      });
      if (!deepEqual(replaceShape(olds), replaceShape(news))) {
        return { action: "replace" as const, deleteFirst: true };
      }
      if (
        !deepEqual(olds.networks ?? [], news.networks ?? []) ||
        (olds.start ?? false) !== (news.start ?? false)
      ) {
        return { action: "update" as const };
      }
    }),
    reconcile: Effect.fnUntraced(function* ({
      id,
      instanceId,
      news,
      output,
      session,
    }) {
      const name = yield* containerName(id, news, instanceId);
      const imageRef = imageRefOf(news.image);
      const live = yield* inspectContainer(name);

      if (live && shouldReplaceContainer(imageRef, news, live)) {
        yield* session.note(`Replacing Docker container: ${name}`);
        yield* removeContainer(name, true);
      } else if (live) {
        const current = yield* reconcileNetworksAndState(name, news, live);
        if (!current) {
          return yield* Effect.die(
            `Docker container disappeared during reconcile: ${name}`,
          );
        }
        return toContainerAttributes(current, imageRef);
      }

      yield* session.note(
        output
          ? `Recreating Docker container: ${name}`
          : `Creating Docker container: ${name}`,
      );
      const created = yield* createAndInspect(name, imageRef, news);
      return toContainerAttributes(created, imageRef);
    }),
    delete: Effect.fnUntraced(function* ({ output, session }) {
      yield* session.note(`Removing Docker container: ${output.name}`);
      yield* stopContainer(output.name);
      yield* removeContainer(output.name, true);
    }),
  });
