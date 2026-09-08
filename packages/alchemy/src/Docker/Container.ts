import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../Tags.ts";
import { toSeconds } from "../Util/Duration.ts";
import { arrayEquals, setEquals } from "../Util/equal.ts";
import { Docker, dockerContextName, dockerPhysicalName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";

/** The network a container joins when `networks` is not set. */
const DEFAULT_NETWORK = "bridge";

/** Docker adds the short container id as a network alias. Ignore it. */
const SHORT_ID_LENGTH = 12;

/** Docker sets `memory-swap` to twice `memory` when it is not given. */
const DEFAULT_MEMORY_SWAP_RATIO = 2;

export interface ContainerProps {
  /** Image reference or Docker image resource. */
  image: Container.Image;
  /** Docker context name or context resource. */
  context?: Docker.ContextRef;
  /**
   * Container name.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Command to run in the container. */
  command?: string[];
  /** Container environment variables. Use Redacted for secrets. */
  environment?: Record<string, string | Redacted.Redacted<string>>;
  /** Host/container port mappings. */
  ports?: Container.PortMapping[];
  /** Volume or bind mounts. */
  volumes?: Container.VolumeMapping[];
  /** Restart policy. */
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  /**
   * Container labels. Alchemy's internal ownership labels are added
   * automatically.
   */
  labels?: Record<string, string>;
  /**
   * Grace period before Docker forcefully kills the container after stopping
   * it.
   */
  stopTimeout?: Duration.Input;
  /**
   * Networks the container joins. The first network is set at create time,
   * so the container does not join the default bridge. The other networks
   * are connected before start. Unset means the default bridge.
   */
  networks?: Container.NetworkMapping[];
  /**
   * Extra `/etc/hosts` entries, each `hostname:address`. Docker's
   * `host-gateway` alias resolves to the host machine, so
   * `"host.docker.internal:host-gateway"` reaches services listening on the
   * developer's machine from inside the container.
   *
   * On Linux `host-gateway` is the bridge gateway address, so those packets
   * traverse the host's `INPUT` chain — under a default-deny firewall the
   * name resolves and the connection then times out. See the Host Access
   * examples.
   */
  extraHosts?: string[];
  /** Remove the container when it exits. @default false */
  removeOnExit?: boolean;
  /** Start the container after creation/reconciliation. @default false */
  start?: boolean;
  /** Docker healthcheck configuration. */
  healthcheck?: Container.Healthcheck;
  /** Memory limit in Docker byte-suffix format ("512m", "2g"). */
  memory?: string;
  /** Memory-plus-swap limit, same format. Set equal to memory to disable swap. */
  memorySwap?: string;
  /**
   * Set `no-new-privileges`. Processes in the container cannot gain
   * privileges through setuid or setgid binaries.
   *
   * @default false
   */
  noNewPrivileges?: boolean;
  /**
   * Mount the container's root filesystem read-only. Writable paths must
   * be provided explicitly as volumes or tmpfs.
   *
   * @default false
   */
  readOnly?: boolean;
}

export declare namespace Container {
  type Status =
    | "created"
    | "running"
    | "paused"
    | "restarting"
    | "removing"
    | "exited"
    | "dead";
  type Image = string | { imageRef: string };
  interface PortMapping {
    /** External port on the host. */
    external: number | string;
    /** Internal port inside the container. */
    internal: number | string;
    /** Protocol used for the mapping. @default "tcp" */
    protocol?: "tcp" | "udp";
  }
  interface VolumeMapping {
    /** Host path or named volume source. */
    hostPath: string;
    /** Container path. */
    containerPath: string;
    /** Mount read-only. @default false */
    readOnly?: boolean;
  }
  interface NetworkMapping {
    /** Network name or ID. */
    name: string;
    /** Network aliases for the container. */
    aliases?: string[];
  }
  interface Healthcheck {
    /** Command to run for health checks. */
    cmd: string[] | string;
    /** Time between checks. */
    interval?: Duration.Input;
    /** Maximum time a check may run. */
    timeout?: Duration.Input;
    /** Consecutive failures before unhealthy. */
    retries?: number;
    /** Startup grace period. */
    startPeriod?: Duration.Input;
    /** Check interval during startup. Requires Docker API 1.44+. */
    startInterval?: Duration.Input;
  }
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
    status: Container.Status;
    /** Creation timestamp in milliseconds since epoch. */
    createdAt: number;
    /** Image reference used to create the container. */
    imageRef: string;
    /**
     * Map of internal container ports to their bound host ports.
     * Format: `"80/tcp" -> 8080`.
     */
    ports: Record<string, number>;
  },
  never,
  Providers
> {}

/**
 * A Docker container managed through the active Docker context.
 *
 * This resource creates, starts, stops, inspects, and removes containers through
 * the Docker CLI. It is not interchangeable with `Cloudflare.Container`, which
 * manages Cloudflare's container platform; use pushed image references to bridge
 * Docker-built images into cloud container runtimes.
 *
 * Container config is immutable. A changed create-time prop replaces the
 * container. Alchemy also compares the desired props with the observed
 * container: `image`, `environment`, `command`, `ports`, `volumes`,
 * `memory`, `memorySwap`, `readOnly`, `noNewPrivileges`, `restart`,
 * `stopTimeout`, `removeOnExit`, `labels`, and `healthcheck`. A mismatch
 * plans a replace. Docker merges the image environment and labels into the
 * container, so a removed `environment` entry or `label` is not detected by
 * observation. An unset `command` or `healthcheck` inherits from the image
 * and is not compared by observation.
 *
 *
 * ### Running Containers
 * **Example:** Nginx with a published port
 * ```typescript
 * const nginx = yield* Docker.Container("nginx", {
 *   image: "nginx:alpine",
 *   ports: [{ external: 8080, internal: 80 }],
 *   start: true,
 * });
 * ```
 *
 * ### Secret Environment
 * **Example:** Redacted env var
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
 * ### Networks and Volumes
 * **Example:** PostgreSQL with persistent storage
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
 * const runtime = yield* Docker.inspectContainer(postgresName);
 * ```
 *
 * ### Host Access
 * `extraHosts` writes lines into the container's `/etc/hosts`; it changes name
 * resolution and nothing else. Docker's `host-gateway` alias resolves to the
 * host machine, which is how a container reaches a service on the developer's
 * loopback.
 *
 * On Linux `host-gateway` is the Docker bridge gateway (typically
 * `172.17.0.1`), so a container's packets to it arrive on the host's `INPUT`
 * chain. Under a default-deny firewall — ufw ships
 * `DEFAULT_INPUT_POLICY="DROP"` — the hostname resolves correctly and the
 * connection then times out, which reads like an application bug rather than a
 * firewall one. Allow the bridge subnet to fix it:
 * `sudo ufw allow from 172.16.0.0/12`.
 *
 * **Example:** Reach a service on the developer's machine
 * ```typescript
 * const api = yield* Docker.Container("api", {
 *   image: "ghcr.io/acme/api:latest",
 *   // `host-gateway` resolves to the host machine, so a database listening
 *   // on the developer's loopback is reachable from inside the container.
 *   extraHosts: ["host.docker.internal:host-gateway"],
 *   environment: {
 *     DATABASE_URL: "postgres://postgres@host.docker.internal:5432/app",
 *   },
 *   start: true,
 * });
 * ```
 *
 * **Example:** Pin a hostname to a fixed address
 * ```typescript
 * const api = yield* Docker.Container("api", {
 *   image: "ghcr.io/acme/api:latest",
 *   // Any `hostname:address` pair — host access is just the common case.
 *   extraHosts: ["payments.internal:10.1.2.3"],
 *   start: true,
 * });
 * ```
 *
 * **Example:** Publish on any free host port
 * ```typescript
 * const api = yield* Docker.Container("api", {
 *   image: "ghcr.io/acme/api:latest",
 *   // `external: 0` lets Docker choose; the assigned port is reported back.
 *   ports: [{ external: 0, internal: 3000 }],
 *   start: true,
 * });
 * const hostPort = api.ports["3000/tcp"];
 * ```
 *
 * ### Traefik
 * **Example:** Route a container through Traefik
 * ```typescript
 * const api = yield* Docker.Container("api", {
 *   image: "ghcr.io/acme/api:latest",
 *   networks: [{ name: "traefik" }],
 *   labels: {
 *     "traefik.enable": "true",
 *     "traefik.http.routers.api.rule": "Host(`api.example.com`)",
 *     "traefik.http.services.api.loadbalancer.server.port": "3000",
 *   },
 *   stopTimeout: "30 seconds",
 *   start: true,
 * });
 * ```
 *
 * **Example:** Use a Docker.Context resource
 * ```typescript
 * const remote = yield* Docker.Context("remote", {
 *   name: "remote-build",
 *   docker: "host=ssh://docker@example.com",
 * });
 *
 * const api = yield* Docker.Container("api", {
 *   image: "nginx:alpine",
 *   context: remote,
 * });
 * ```
 *
 * @resource
 * @resource
 */
export const Container = Resource<Container>("Docker.Container");

/**
 * Inspect a Docker container by name and return normalized runtime details.
 *
 * This is a small public wrapper around Docker's raw inspect output. It returns
 * the stable data Alchemy callers typically need, including bound host ports.
 */
export const inspectContainer = (
  name: string,
  context?: Docker.ContextRef,
): Effect.Effect<Container["Attributes"], PlatformError, Docker> =>
  Docker.pipe(
    Effect.flatMap((docker) =>
      docker.container.inspect(name, dockerContextName(context)),
    ),
    Effect.map((container) =>
      toContainerAttributes(container, container.Config.Image),
    ),
  );

type CreateArgs = Parameters<Docker["Service"]["container"]["create"]>[0];

export const ContainerProvider = () =>
  Provider.effect(
    Container,
    Effect.gen(function* () {
      const docker = yield* Docker;

      const inspectOrUndefined = (nameOrId: string, context?: string) =>
        docker.container
          .inspect(nameOrId, context)
          .pipe(
            Effect.catchReason(
              "PlatformError",
              "NotFound",
              () => Effect.undefined,
            ),
          );

      const stopAndRemove = (nameOrId: string, context?: string) =>
        docker.container.stop(nameOrId, context).pipe(
          Effect.andThen(docker.container.remove(nameOrId, true, context)),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
        );

      const reconcileNetworks = Effect.fn(function* (
        live: Docker.Container,
        news: ContainerProps,
        olds: ContainerProps | undefined,
      ) {
        const context = dockerContextName(news.context);
        const liveNetworks = live.NetworkSettings.Networks ?? {};
        const shortId = live.Id.slice(0, SHORT_ID_LENGTH);
        const desired = new Map(
          (news.networks ?? []).map((network) => [network.name, network]),
        );
        const declared = new Set(
          [...(olds?.networks ?? []), ...(news.networks ?? [])].map(
            (network) => network.name,
          ),
        );
        const isAttachedAsDesired = (network: Container.NetworkMapping) => {
          const entry = liveNetworks[network.name];
          if (!entry) return false;
          const liveAliases = (entry.Aliases ?? []).filter(
            (alias) => alias !== shortId,
          );
          return setEquals(liveAliases, network.aliases);
        };
        const wanted = [...desired.values()].filter(
          (network) => !isAttachedAsDesired(network),
        );
        const disconnect = Object.keys(liveNetworks).filter(
          (name) =>
            (declared.has(name) && !desired.has(name)) ||
            wanted.some((network) => network.name === name),
        );
        // No declared networks means Docker's default: keep the container on
        // the bridge, alongside anything a user or another tool attached.
        const connect =
          desired.size === 0 && liveNetworks[DEFAULT_NETWORK] === undefined
            ? [{ name: DEFAULT_NETWORK }]
            : wanted;
        // A restarting container can change its networks between inspect and
        // connect. Treat AlreadyExists and NotFound as success.
        yield* Effect.forEach(
          disconnect,
          (network) =>
            docker.network
              .disconnect({ network, container: live.Id, context })
              .pipe(
                Effect.catchReason(
                  "PlatformError",
                  "NotFound",
                  () => Effect.void,
                ),
              ),
          { concurrency: "unbounded" },
        );
        yield* Effect.forEach(
          connect,
          (network) =>
            docker.network
              .connect({
                network: network.name,
                container: live.Id,
                alias: network.aliases,
                context,
              })
              .pipe(
                Effect.catchReason(
                  "PlatformError",
                  "AlreadyExists",
                  () => Effect.void,
                ),
              ),
          { concurrency: "unbounded" },
        );
      });

      const keepOrRemoveLiveContainer = Effect.fn(function* (input: {
        id: string;
        live: Docker.Container;
        args: CreateArgs;
        news: ContainerProps;
        olds: ContainerProps | undefined;
        output: Container["Attributes"] | undefined;
      }) {
        const { id, live, args, news, olds, output } = input;
        const context = dockerContextName(news.context);
        if (findObservedDrift(live, args).length === 0) {
          yield* reconcileNetworks(live, news, olds);
          if (news.start && live.State.Status !== "running") {
            yield* docker.container.start(live.Id, context);
          } else if (!news.start && live.State.Status === "running") {
            yield* docker.container.stop(live.Id, context);
          }
          const info = yield* docker.container.inspect(live.Id, context);
          return Option.some(toContainerAttributes(info, args.image));
        }
        // Container config is immutable. Changed create-args can reach
        // reconcile without a replace plan. Recreate the container to apply
        // them.
        const owned =
          output?.id === live.Id ||
          (yield* hasAlchemyTags(id, live.Config.Labels ?? undefined));
        if (!owned) {
          return yield* new OwnedBySomeoneElse({
            message:
              `Container '${args.name}' (${live.Id}) already exists. ` +
              "Alchemy did not create it. Pick a different `name`, or " +
              "re-run with `--adopt` (or `adopt(true)`) to take it over.",
            resourceType: Container.Type,
            logicalId: id,
            physicalName: args.name,
          });
        }
        yield* stopAndRemove(live.Id, context);
        return Option.none();
      });

      return Container.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const context = dockerContextName(olds.context);
          const name = yield* dockerPhysicalName(id, olds, instanceId);
          const info = yield* inspectOrUndefined(name, context);
          if (!info) return undefined;
          // A `creating` row can lose an Output-valued `image`. Use the live
          // image then.
          const attrs = toContainerAttributes(
            info,
            olds.image !== undefined
              ? normalizeImageRef(olds.image)
              : info.Config.Image,
          );
          if (output) return attrs;
          const owned = yield* hasAlchemyTags(
            id,
            info.Config.Labels ?? undefined,
          );
          return owned ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          // A `creating` row can lose an Output-valued `image`. Let the engine
          // apply its default update logic then.
          if (olds.image === undefined) return undefined;
          const context = dockerContextName(news.context);
          if (dockerContextName(olds.context) !== context) {
            return { action: "replace" as const, deleteFirst: true };
          }
          const oldArgs = yield* makeCreateArgs(id, olds, instanceId);
          const newArgs = yield* makeCreateArgs(id, news, instanceId);
          if (!Equal.equals(oldArgs, newArgs)) {
            return { action: "replace" as const, deleteFirst: true };
          }
          // An adopted container arrives with `news` as its `olds`. Compare
          // the desired args with the live container to plan drift honestly.
          const live =
            output === undefined
              ? undefined
              : yield* inspectOrUndefined(output.id, context);
          if (
            live !== undefined &&
            findObservedDrift(live, newArgs).length > 0
          ) {
            return { action: "replace" as const, deleteFirst: true };
          }
          if (
            !Equal.equals(olds.networks ?? [], news.networks ?? []) ||
            (olds.start ?? false) !== (news.start ?? false)
          ) {
            return { action: "update" as const };
          }
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          olds,
          output,
        }) {
          const context = dockerContextName(news.context);
          const args = yield* makeCreateArgs(id, news, instanceId);

          // A rename can reach reconcile without a replace plan. State points
          // at the old container by id, so it is ours. Remove it so two
          // containers do not run.
          if (output !== undefined && output.name !== args.name) {
            yield* stopAndRemove(output.id, context);
          }

          const live = yield* inspectOrUndefined(args.name, context);
          if (live !== undefined) {
            const kept = yield* keepOrRemoveLiveContainer({
              id,
              live,
              args,
              news,
              olds,
              output,
            });
            if (Option.isSome(kept)) return kept.value;
          }

          const internalTags = yield* createInternalTags(id);
          // Set the first network at create time. This keeps the container
          // off the default bridge.
          const [firstNetwork, ...otherNetworks] = news.networks ?? [];
          const { stdout: containerId } = yield* docker.container.create({
            ...args,
            context,
            label: { ...args.label, ...internalTags },
            network: firstNetwork?.name,
            "network-alias": firstNetwork?.aliases,
          });
          yield* Effect.forEach(
            otherNetworks,
            (network) =>
              docker.network.connect({
                network: network.name,
                container: containerId,
                alias: network.aliases,
                context,
              }),
            { concurrency: "unbounded" },
          );
          if (news.start) {
            yield* docker.container.start(containerId, context);
          }
          const info = yield* docker.container.inspect(containerId, context);
          return toContainerAttributes(info, args.image);
        }),
        // Resolve by id. A foreign container can own the name by now.
        delete: Effect.fn(({ olds, output }) =>
          stopAndRemove(output.id, dockerContextName(olds.context)),
        ),
      });
    }),
  );

const normalizeImageRef = (image: Container.Image): string =>
  typeof image === "string" ? image : image.imageRef;

const makeCreateArgs = (id: string, news: ContainerProps, instanceId: string) =>
  dockerPhysicalName(id, news, instanceId).pipe(
    Effect.map((name): CreateArgs => ({
      name,
      image: normalizeImageRef(news.image),
      command: news.command,
      env: normalizeEnvironment(news.environment),
      volume: news.volumes?.map(
        (v) => `${v.hostPath}:${v.containerPath}${v.readOnly ? ":ro" : ""}`,
      ),
      p: news.ports?.map((port) => {
        const target = `${port.internal}/${port.protocol ?? "tcp"}`;
        // `external: 0` means "any free host port". Docker spells that as a
        // bare container port (`-p 80/tcp`); `-p 0:80/tcp` instead asks for
        // host port 0 literally, which the daemon accepts and then reports
        // back as 0.
        return isRandomHostPort(port.external)
          ? target
          : `${port.external}:${target}`;
      }),
      "add-host": news.extraHosts,
      restart: news.restart ?? "no",
      label: news.labels,
      "stop-timeout": toSeconds(news.stopTimeout)?.toString(),
      rm: news.removeOnExit ?? false,
      memory: news.memory,
      "memory-swap": news.memorySwap,
      "security-opt": news.noNewPrivileges ? ["no-new-privileges"] : undefined,
      "read-only": news.readOnly ?? false,
      ...(news.healthcheck
        ? {
            "health-cmd": Array.isArray(news.healthcheck.cmd)
              ? news.healthcheck.cmd.join(" ")
              : news.healthcheck.cmd,
            "health-interval": normalizeDuration(news.healthcheck.interval),
            "health-timeout": normalizeDuration(news.healthcheck.timeout),
            "health-retries": news.healthcheck.retries ?? 0,
            "health-start-period": normalizeDuration(
              news.healthcheck.startPeriod,
            ),
            "health-start-interval": normalizeDuration(
              news.healthcheck.startInterval,
            ),
          }
        : {
            "health-cmd": undefined,
            "health-interval": undefined,
            "health-timeout": undefined,
            "health-retries": undefined,
            "health-start-period": undefined,
            "health-start-interval": undefined,
          }),
    })),
  );

/**
 * Names of the create-args that differ from the observed container. An empty
 * list means the container matches.
 */
const findObservedDrift = (
  live: Docker.Container,
  args: CreateArgs,
): string[] => {
  const memory = parseByteSize(args.memory) ?? 0;
  const memorySwap =
    parseByteSize(args["memory-swap"]) ?? memory * DEFAULT_MEMORY_SWAP_RATIO;
  const checks: Array<[prop: string, matches: boolean]> = [
    ["image", live.Config.Image === args.image],
    [
      "environment",
      includesAll(live.Config.Env ?? [], formatKeyValues(args.env)),
    ],
    [
      "command",
      args.command === undefined ||
        arrayEquals(live.Config.Cmd ?? [], args.command),
    ],
    [
      "ports",
      setEquals(formatPortBindings(live.HostConfig.PortBindings), args.p),
    ],
    ["volumes", setEquals(live.HostConfig.Binds ?? [], args.volume)],
    ["memory", live.HostConfig.Memory === memory],
    ["memorySwap", live.HostConfig.MemorySwap === memorySwap],
    [
      "readOnly",
      live.HostConfig.ReadonlyRootfs === (args["read-only"] ?? false),
    ],
    [
      "noNewPrivileges",
      setEquals(live.HostConfig.SecurityOpt ?? [], args["security-opt"]),
    ],
    ["restart", (live.HostConfig.RestartPolicy.Name || "no") === args.restart],
    [
      "stopTimeout",
      live.Config.StopTimeout === parseInteger(args["stop-timeout"]),
    ],
    ["removeOnExit", live.HostConfig.AutoRemove === args.rm],
    [
      "labels",
      includesAll(
        formatKeyValues(live.Config.Labels ?? undefined),
        formatKeyValues(args.label),
      ),
    ],
    ["healthcheck", matchesHealthcheck(live.Config.Healthcheck, args)],
  ];
  return checks.filter(([, matches]) => !matches).map(([prop]) => prop);
};

const matchesHealthcheck = (
  live: Docker.Container["Config"]["Healthcheck"],
  args: CreateArgs,
): boolean => {
  if (args["health-cmd"] === undefined) return true;
  if (!live) return false;
  return (
    arrayEquals(live.Test ?? [], ["CMD-SHELL", args["health-cmd"]]) &&
    (live.Interval ?? 0) === parseNanoseconds(args["health-interval"]) &&
    (live.Timeout ?? 0) === parseNanoseconds(args["health-timeout"]) &&
    (live.Retries ?? 0) === (args["health-retries"] ?? 0) &&
    (live.StartPeriod ?? 0) === parseNanoseconds(args["health-start-period"]) &&
    (live.StartInterval ?? 0) ===
      parseNanoseconds(args["health-start-interval"])
  );
};

const formatKeyValues = (
  record: Record<string, string> | undefined,
): string[] =>
  Object.entries(record ?? {}).map(([key, value]) => `${key}=${value}`);

/** Formats observed port bindings in the `-p` syntax (`8080:80/tcp`). */
const formatPortBindings = (
  bindings: Docker.Container["HostConfig"]["PortBindings"],
): string[] =>
  Object.entries(bindings ?? {}).flatMap(([internal, hosts]) =>
    (hosts ?? []).map((host) =>
      host.HostIp
        ? `${host.HostIp}:${host.HostPort}:${internal}`
        : `${host.HostPort}:${internal}`,
    ),
  );

/** Parses a Docker byte-suffix size (`512m`, `2g`, `1.5gb`) into bytes. */
const parseByteSize = (size: string | undefined): number | undefined => {
  if (size === undefined) return undefined;
  if (size === "-1") return -1;
  const match = /^(\d+(?:\.\d+)?)\s*([bkmgtp]?)(?:i?b)?$/i.exec(size.trim());
  if (!match) return undefined;
  const scale = "bkmgtp".indexOf(match[2]!.toLowerCase() || "b");
  return Math.floor(Number(match[1]) * 1024 ** scale);
};

const parseInteger = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number.parseInt(value, 10);

const parseNanoseconds = (duration: string | undefined): number =>
  duration === undefined ? 0 : Number.parseInt(duration, 10);

const includesAll = (
  list: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
): boolean => {
  const set = new Set(list);
  return required.every((item) => set.has(item));
};

const toContainerAttributes = (
  info: Docker.Container,
  imageRef: string,
): Container["Attributes"] => ({
  id: info.Id,
  name: typeof info.Name === "string" ? info.Name.replace(/^\//, "") : info.Id,
  status: info.State.Status,
  createdAt: Date.parse(info.Created) || Date.now(),
  imageRef,
  ports: toPortAttributes(info),
});

/** First binding that carries a real (non-zero) host port. */
const boundHostPort = (
  bindings: ReadonlyArray<{ HostPort?: string }> | null | undefined,
): number | undefined => {
  for (const binding of bindings ?? []) {
    if (!binding.HostPort) continue;
    const port = Number.parseInt(binding.HostPort, 10);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return undefined;
};

/**
 * `HostConfig.PortBindings` is what was *requested*, `NetworkSettings.Ports`
 * what Docker actually *assigned* — so the assignment wins wherever both
 * exist. A container published with `external: 0` (or any random-publish
 * mapping) has no requested host port at all, and reading the request over
 * the assignment reported 0 instead of the port the container is reachable
 * on. The request is still the fallback: a created-but-not-yet-started
 * container has empty `NetworkSettings.Ports`.
 */
const toPortAttributes = (info: Docker.Container): Record<string, number> => {
  const ports: Record<string, number> = {};
  for (const [internal, bindings] of Object.entries(
    info.HostConfig.PortBindings ?? {},
  )) {
    const port = boundHostPort(bindings);
    if (port !== undefined) ports[internal] = port;
  }
  for (const [internal, bindings] of Object.entries(
    info.NetworkSettings.Ports ?? {},
  )) {
    const port = boundHostPort(bindings);
    if (port !== undefined) ports[internal] = port;
  }
  return ports;
};

/** `external: 0` / `"0"` asks Docker to pick any free host port. */
const isRandomHostPort = (external: number | string): boolean =>
  Number.parseInt(String(external), 10) === 0;

const normalizeEnvironment = (
  environment: Record<string, string | Redacted.Redacted<string>> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment ?? {}).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

const normalizeDuration = (
  input: Duration.Input | undefined,
): string | undefined => {
  if (!input) return undefined;
  const duration = Duration.fromInputUnsafe(input);
  // Docker parses `--health-*` durations with Go `time.ParseDuration`. It
  // requires a unit suffix. `ns` is lossless.
  return `${Duration.toNanosUnsafe(duration).toString()}ns`;
};
