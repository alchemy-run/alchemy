import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, hasAlchemyTags } from "alchemy/Tags";
import { toSeconds } from "alchemy/Util/Duration";
import { sha256, sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Docker, dockerContextName, dockerPhysicalName } from "./Docker.ts";
import { healthcheckCommand, isHealthcheckDisabled } from "./HealthcheckCommand.ts";
import { parseDockerByteSizeMagnitude } from "./internal/DockerByteSize.ts";
import type { Providers } from "./Providers.ts";

const CREATE_CONFIG_HASH_LABEL = "alchemy::container-config";

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
  /** Override the image's executable (`--entrypoint`); arguments belong in `command`. */
  entrypoint?: string;
  /** Absolute working directory for the container process. */
  workingDirectory?: string;
  /** Container image platform, e.g. `"linux/amd64"`; requires host support. */
  platform?: string;
  /** Container environment variables. Use Redacted for secrets. */
  environment?: Record<string, string | Redacted.Redacted<string>>;
  /** Hostname inside the container. Changing it recreates the container. */
  hostname?: string;
  /** Custom DNS server IP addresses. Docker defaults apply when omitted. */
  dns?: string[];
  /** DNS search domains; applied at container creation. */
  dnsSearch?: string[];
  /** Resolver options, for example `["ndots:1"]`; applied at creation. */
  dnsOptions?: string[];
  /**
   * Paths to Docker env files, forwarded in the declared order as repeated
   * `--env-file` options. Explicit `environment` values are forwarded after
   * these files and take precedence in Docker. Editing a file's contents
   * replaces the container on the next deploy. Only a digest of the contents
   * is kept, on the container's own label; neither contents nor digest are
   * written to Alchemy state. Docker itself exposes the resolved values
   * through `docker inspect`, so treat env files as secrets.
   */
  envFiles?: string[];
  /** Host/container port mappings. */
  ports?: Container.PortMapping[];
  /** Volume or bind mounts. */
  volumes?: Container.VolumeMapping[];
  /** Restart policy. */
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  /**
   * Container labels. Alchemy's internal ownership labels are added
   * automatically; the `alchemy::` prefix is reserved.
   */
  labels?: Record<string, string>;
  /**
   * Grace period before Docker forcefully kills the container after stopping
   * it.
   */
  stopTimeout?: Duration.Input;
  /**
   * Managed network attachments. When set, Docker creates the container on
   * the first network rather than implicitly joining the default `bridge`.
   * Other endpoints are connected before the container starts.
   */
  networks?: Container.NetworkMapping[];
  /**
   * Network namespace. Use `{ container: id }` to share another container's
   * namespace. Container-shared networking cannot set a hostname, custom DNS,
   * extra hosts, published ports or separate network attachments.
   */
  networkMode?: Container.NetworkMode;
  /** IPC namespace selection, e.g. `"private"`, `"host"` or `"container:<id>"`. */
  ipcNamespace?: string;
  /** PID namespace selection, e.g. `"host"` or `"container:<id>"`. Omit for the private default. */
  pidNamespace?: string;
  /** Namespace-scoped kernel settings. Docker rejects unsupported or host-wide sysctls. */
  sysctls?: Record<string, string>;
  /** Linux capabilities to add, for example `SYS_ADMIN`. */
  capAdd?: string[];
  /** Linux capabilities to drop, for example `["ALL"]`. */
  capDrop?: string[];
  /** Hard memory limit in Docker's byte-suffix format, e.g. `"512m"`. */
  memory?: string;
  /**
   * Size of `/dev/shm`, e.g. `"256m"`; separate from the container memory limit.
   * Requires a private or shareable IPC namespace; host/container IPC shares
   * another namespace's memory and cannot be resized by this container.
   */
  sharedMemorySize?: string;
  /**
   * Combined memory-plus-swap limit in Docker's byte-suffix format.
   * Requires `memory`. Set to the same value to disable swap, or `"-1"`
   * to allow unlimited swap (subject to the host).
   */
  memorySwap?: string;
  /** Soft memory limit under contention, e.g. `"256m"`. */
  memoryReservation?: string;
  /** CPU quota, in cores (e.g. `0.5` limits to half a CPU). */
  cpus?: number;
  /** Maximum number of processes and threads in the container. */
  pidsLimit?: number;
  /** Mount the container's root filesystem read-only. Writable paths need a volume or tmpfs. */
  readOnlyRootFilesystem?: boolean;
  /** Prevent processes from gaining additional privileges through exec. */
  noNewPrivileges?: boolean;
  /** Disable Docker's default isolation safeguards; use only for trusted workloads. @default false */
  privileged?: boolean;
  /** Run Docker's init process to forward signals and reap child processes. */
  init?: boolean;
  /** Runtime user, e.g. `"1000:1000"` or `"app"`. Omit to keep the image's user. */
  user?: string;
  /** Keep standard input open when the container is not attached. @default false */
  keepStdinOpen?: boolean;
  /** Allocate a pseudo-terminal for the main process. @default false */
  allocatePseudoTerminal?: boolean;
  /** Request GPU devices, e.g. `"all"` or `"device=0"`; requires a GPU-capable runtime. */
  gpuDevices?: string;
  /**
   * Seccomp JSON profile path on the Docker CLI host, or `"builtin"` to
   * select Docker's default policy. `"unconfined"` explicitly disables it.
   * Changes to a profile file's contents recreate the container.
   */
  seccompProfile?: string;
  /**
   * Name of a preloaded AppArmor profile, e.g. `"docker-default"`.
   * Requires AppArmor support on the target host. `"unconfined"` disables it.
   */
  appArmorProfile?: string;
  /** Docker user-namespace mode. `"host"` opts out of daemon user remapping. */
  userNamespace?: string;
  /** Supplementary Linux group names or numeric GIDs. */
  groupAdd?: string[];
  /** Per-process resource limits. `-1` represents unlimited. */
  ulimits?: Record<string, Container.Ulimit>;
  /** Docker log driver, e.g. `"local"`, `"json-file"`, or `"none"`. */
  logDriver?: string;
  /** Driver-specific settings, such as `{ "max-size": "10m", "max-file": "3" }`. */
  logOptions?: Record<string, string>;
  /** Relative OOM score adjustment on Linux, from -1000 to 1000. */
  oomScoreAdjustment?: number;
  /** Stop signal, e.g. `"SIGTERM"` or `"SIGINT"`. */
  stopSignal?: string;
  /** Writable in-memory mounts, including size and POSIX mode controls. */
  tmpfs?: Container.TmpfsMount[];
  /** Host devices to expose to the container. */
  devices?: Container.DeviceMapping[];
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
}

export declare namespace Container {
  type Status = "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead";
  type Image = string | { imageRef: string; imageId?: string };
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
  interface TmpfsMount {
    /** Absolute mount target in the container, e.g. `"/tmp"`. */
    path: string;
    /** Docker byte-suffix size, e.g. `"32m"`. Omit for the engine default. */
    size?: string;
    /** POSIX mode as a number, e.g. `0o1777` for a sticky world-writable directory. */
    mode?: number;
  }
  interface Ulimit {
    /** Process soft limit. `-1` means unlimited. */
    soft: number;
    /** Process hard limit. `-1` means unlimited. */
    hard: number;
  }
  interface NetworkMapping {
    /** Network name or ID. */
    name: string;
    /** Network aliases for the container. */
    aliases?: string[];
    /** Static IPv4 address from the referenced network's subnet. */
    ipv4Address?: string;
    /** Static IPv6 address; the referenced network must have IPv6 enabled. */
    ipv6Address?: string;
    /** Default gateway preference for this attachment. @default 0 */
    gatewayPriority?: number;
    /** Driver options for this endpoint, not the underlying Docker.Network. */
    driverOpts?: Record<string, string>;
  }
  type NetworkMode = string | { container: string };
  interface DeviceMapping {
    /** Host device path. */
    hostPath: string;
    /** Container device path. */
    containerPath: string;
    /** Cgroup permissions. @default "rwm" */
    permissions?: string;
  }
  interface Healthcheck {
    /**
     * Command to run for health checks. A string runs in the container's
     * shell. An array follows Docker's healthcheck `Test` form:
     * `["CMD-SHELL", "pg_isready -U app"]`, `["CMD", "pg_isready", "-U", "app"]`,
     * or `["NONE"]` to disable the image's healthcheck.
     */
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
    /** Configured network namespace, when reported by Docker. */
    networkMode?: string;
    /** Added Linux capabilities, when reported by Docker. */
    capAdd?: string[];
    /** Configured host devices, when reported by Docker. */
    devices?: Container.DeviceMapping[];
  },
  never,
  Providers,
  ContainerLookup
> {}

/**
 * Props for {@link Container.lookup}: find a container this stack
 * doesn't manage by its name.
 */
export interface ContainerLookup {
  /** Container name. */
  name: string;
  /**
   * Docker context the engine is reached through.
   * @default the current context
   */
  context?: string;
}

/**
 * A Docker container managed through the active Docker context.
 *
 * This resource creates, starts, stops, inspects, and removes containers through
 * the Docker CLI. It is not interchangeable with `Cloudflare.Container`, which
 * manages Cloudflare's container platform; use pushed image references to bridge
 * Docker-built images into cloud container runtimes.
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
 * const password = yield* Config.Redacted("POSTGRES_PASSWORD");
 * const db = yield* Docker.Container("postgres", {
 *   image: "postgres:18-alpine",
 *   environment: {
 *     POSTGRES_PASSWORD: password,
 *   },
 *   start: true,
 * });
 * ```
 *
 * ### Environment Files
 * **Example:** Layered Docker env files
 * ```typescript
 * const app = yield* Docker.Container("app", {
 *   image: "ghcr.io/acme/app:latest",
 *   envFiles: ["./config/base.env", "./config/production.env"],
 *   // Explicit values are passed after env files and take precedence.
 *   environment: { LOG_LEVEL: "info" },
 * });
 * ```
 *
 * Editing an env file replaces the container on the next deploy, as does
 * adopting a container that uses env files (once, so later edits are tracked).
 * Alchemy reads
 * the files at plan time but keeps only a digest of their contents, on the
 * container's own label; neither the values nor the digest are written to
 * Alchemy state. Docker exposes the resolved values through `docker inspect`,
 * so treat env files as secrets.
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
 * ### Configured network endpoints
 * `Docker.Network` owns subnets, IPAM and driver settings for the shared network.
 * The container declares only its own attachment: alias, optional static IP,
 * gateway priority and endpoint driver options. Docker allocates IPs when omitted.
 *
 * **Example:** Attach to a dual-stack network with a fixed address
 * ```typescript
 * const network = yield* Docker.Network("backend", {
 *   enableIPv6: true,
 *   ipam: { config: [
 *     { subnet: "10.51.0.0/24" },
 *     { subnet: "fd51:3456:789a::/64" },
 *   ] },
 * });
 * yield* Docker.Container("api", {
 *   image: "nginx:alpine",
 *   hostname: "api",
 *   networks: [{
 *     name: network.name,
 *     aliases: ["api"],
 *     ipv4Address: "10.51.0.10",
 *     ipv6Address: "fd51:3456:789a::10",
 *     gatewayPriority: 1,
 *   }],
 *   start: true,
 * });
 * ```
 *
 * Declaring `networks` without `networkMode` attaches only the listed networks:
 * Docker's implicit default `bridge` is not added. On legacy/adopted containers,
 * Alchemy detaches that implicit bridge while keeping externally added networks.
 * Omitting both options retains Docker's ordinary default networking.
 * Each attachment must refer to a distinct Docker network, even when the
 * same network is referenced once by name and again by ID.
 *
 * Network attachment changes reconnect only the managed endpoint without
 * replacing the container. Docker can temporarily interrupt traffic during
 * reconnection. If Docker rejects an update, Alchemy attempts to restore the
 * previously observed attachment; restoration can also fail if Docker refuses
 * it, so the update is not atomic. Alchemy leaves
 * externally attached networks untouched. `hostname`, `dns`, `dnsSearch` and
 * `dnsOptions` are creation-time settings and changes replace the container.
 * Invalid options fail with `InvalidContainerOptions`, whose `path` identifies
 * the rejected configuration property before replacement.
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
 *   extraHosts: ["service.example:192.0.2.10"],
 *   start: true,
 * });
 * ```
 *
 * ### Runtime Options
 * **Example:** Allocate shared memory for PostgreSQL
 * ```typescript
 * const password = yield* Alchemy.makeRandom("DatabasePassword", { bytes: 16 });
 * yield* Docker.Container("db", {
 *   image: "postgres:18-alpine",
 *   environment: { POSTGRES_PASSWORD: password },
 *   sharedMemorySize: "256m", // --shm-size, not the container memory limit
 *   start: true,
 * });
 * ```
 *
 * **Example:** Configure process, platform, and namespace settings
 * ```typescript
 * yield* Docker.Container("job", {
 *   image: "alpine:3.22",
 *   platform: "linux/amd64",
 *   entrypoint: "/bin/sh",
 *   command: ["-c", "echo ready"],
 *   workingDirectory: "/workspace",
 *   ipcNamespace: "private",
 *   sysctls: { "net.ipv4.ip_unprivileged_port_start": "1024" },
 * });
 * ```
 *
 * **Example:** Contain a background worker
 * ```typescript
 * const worker = yield* Docker.Container("worker", {
 *   image: "oven/bun:1",
 *   memory: "512m",
 *   memorySwap: "512m",
 *   memoryReservation: "256m",
 *   cpus: 0.5,
 *   pidsLimit: 128,
 *   readOnlyRootFilesystem: true,
 *   capDrop: ["ALL"],
 *   noNewPrivileges: true,
 *   init: true,
 *   user: "1000:1000",
 *   tmpfs: [{ path: "/tmp", size: "32m", mode: 0o1777 }],
 * });
 * ```
 *
 * **Example:** Customize confinement, process limits, and log rotation
 * ```typescript
 * const api = yield* Docker.Container("api", {
 *   image: "ghcr.io/acme/api:latest",
 *   seccompProfile: "./security/api-seccomp.json", // client-side JSON; edits roll the container
 *   appArmorProfile: "my-loaded-profile",          // must already be loaded on the host
 *   groupAdd: ["1000"],
 *   ulimits: { nofile: { soft: 1024, hard: 4096 } },
 *   logDriver: "local",
 *   logOptions: { "max-size": "10m", "max-file": "3" },
 *   oomScoreAdjustment: 200,
 *   stopSignal: "SIGTERM",
 * });
 * ```
 *
 * **Example:** Share a donor container's network namespace
 * ```typescript
 * const donor = yield* Docker.Container("donor", { image: "redis:alpine" });
 * const sidecar = yield* Docker.Container("sidecar", {
 *   image: "busybox:latest",
 *   networkMode: { container: donor.id },
 * });
 * ```
 *
 * **Example:** Add capabilities and devices
 * ```typescript
 * const worker = yield* Docker.Container("worker", {
 *   image: "ubuntu:latest",
 *   capAdd: ["SYS_ADMIN"],
 *   devices: [{ hostPath: "/dev/fuse", containerPath: "/dev/fuse" }],
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
 * ### Looking up an existing container
 * `Container.lookup` references a container Alchemy doesn't manage (created with
 * the Docker CLI, Compose or another stack). It is read during plan/deploy,
 * never created, updated or removed.
 *
 * **Example:** Reference an existing container
 * ```typescript
 * const db = Docker.Container.lookup({ name: "postgres" });
 * ```
 *
 * @resource
 * @product Container
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
    Effect.flatMap((docker) => docker.container.inspect(name, dockerContextName(context))),
    Effect.map((container) => toContainerAttributes(container, container.Config.Image)),
  );

export const ContainerProvider = () =>
  Provider.effect(
    Container,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Env files are read so editing one rolls the container, but only a
      // digest of their bytes enters the config hash, which lives solely in
      // the container's own label (where `docker inspect` already exposes
      // the resolved values). Neither contents nor digest reach alchemy state.
      const envFilesDigest = Effect.fn(function* (envFiles: ReadonlyArray<string> | undefined) {
        if (!envFiles?.length) return undefined;
        const digests = yield* Effect.forEach(envFiles, (file) =>
          fs.readFile(path.resolve(file)).pipe(
            Effect.flatMap(sha256),
            Effect.map((digest) => `${file}\0${digest}`),
          ),
        );
        return yield* sha256(digests.join("\n"));
      });

      // Docker CLI loads seccomp profiles from client-side files at create
      // time. Hash the contents as well as the path so policy edits are never
      // silently ignored on subsequent deploys.
      const seccompProfileDigest = Effect.fn(function* (profile: string | undefined) {
        if (!isCustomSeccompProfile(profile)) return undefined;
        return yield* fs.readFile(path.resolve(profile)).pipe(Effect.flatMap(sha256));
      });

      // Without env files the hash input is unchanged from before they were
      // supported, so existing containers keep their label and are not rolled.
      const desiredConfigHash = Effect.fn(function* (
        args: Parameters<Docker["Service"]["container"]["create"]>[0],
        news: ContainerProps,
      ) {
        const envFiles = yield* envFilesDigest(news.envFiles);
        const seccompProfile = yield* seccompProfileDigest(news.seccompProfile);
        return yield* sha256Object({
          ...args,
          imageId: normalizeImageId(news.image),
          ...(envFiles === undefined ? {} : { envFiles }),
          ...(seccompProfile === undefined ? {} : { seccompProfile }),
        });
      });

      const connectNetwork = (
        network: Container.NetworkMapping,
        container: string,
        context: string | undefined,
      ) =>
        docker.network.connect({
          network: network.name,
          container,
          alias: network.aliases,
          ip: network.ipv4Address,
          ip6: network.ipv6Address,
          "gw-priority": network.gatewayPriority,
          "driver-opt": network.driverOpts,
          context,
        });

      // Names and IDs can refer to the same physical network. Resolve only
      // multi-network declarations; check before delete-first replacements
      // and again during reconcile, after new managed networks are created.
      const validateNetworkIdentities = Effect.fn(function* (props: ContainerProps) {
        if ((props.networks?.length ?? 0) < 2) return;
        const seen = new Set<string>();
        const context = dockerContextName(props.context);
        for (const [index, network] of (props.networks ?? []).entries()) {
          const actual = yield* docker.network
            .inspect(network.name, context)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          if (!actual) continue;
          if (seen.has(actual.Id)) {
            return yield* invalidContainerOption(
              `networks[${index}].name`,
              "must be unique (another attachment refers to the same Docker network)",
            );
          }
          seen.add(actual.Id);
        }
      });

      const reconnectNetwork = Effect.fn(function* (
        live: Docker.Container,
        network: Container.NetworkMapping,
        previous: InspectedNetworkEndpoint,
        context: string | undefined,
      ) {
        // Reconnect changes one endpoint. Keep its observed configuration so
        // a rejected IP or driver option cannot strand a working container.
        const restore: Container.NetworkMapping = {
          name: network.name,
          aliases: previous.Aliases ?? undefined,
          ipv4Address: previous.IPAMConfig?.IPv4Address || undefined,
          ipv6Address: previous.IPAMConfig?.IPv6Address || undefined,
          gatewayPriority: previous.GwPriority,
          driverOpts: previous.DriverOpts ?? undefined,
        };
        yield* docker.network.disconnect({ network: network.name, container: live.Id, context });
        yield* connectNetwork(network, live.Id, context).pipe(
          Effect.onError(() =>
            connectNetwork(restore, live.Id, context).pipe(
              Effect.catchCause(() =>
                Effect.logWarning(
                  `Docker.Container could not restore endpoint on ${network.name} after a rejected update`,
                ),
              ),
            ),
          ),
        );
      });

      const reconcileNetworks = Effect.fn(function* (
        live: Docker.Container,
        news: ContainerProps,
        olds: ContainerProps | undefined,
      ) {
        const context = dockerContextName(news.context);
        // Update attachments sequentially so one rejected connection does
        // not disconnect every managed network before returning an error.
        for (const network of news.networks ?? []) {
          const previous = olds?.networks?.find((old) =>
            referencesSameNetwork(live, old.name, network.name),
          );
          if (matchesNetworkEndpoint(live, network, previous)) continue;
          const attached = findNetworkEndpoint(live, network.name);
          if (attached) {
            yield* reconnectNetwork(live, network, attached, context);
          } else {
            yield* connectNetwork(network, live.Id, context);
          }
        }
        // Legacy/adopted containers may still have Docker's implicit bridge.
        // Drop only this known initial attachment, preserving foreign networks.
        if (hasImplicitDefaultBridge(live, news)) {
          yield* docker.network.disconnect({ network: "bridge", container: live.Id, context });
        }
        // Only detach managed networks recorded in `olds.networks`, except
        // for the independently identified implicit default bridge above.
        // Sweeping every live attachment also removes externally connected
        // networks, including ones added by Compose or another tool (#1386).
        for (const network of olds?.networks ?? []) {
          const stillManaged = (news.networks ?? []).some((desired) =>
            referencesSameNetwork(live, desired.name, network.name),
          );
          if (!stillManaged && findNetworkEndpoint(live, network.name)) {
            yield* docker.network.disconnect({
              network: network.name,
              container: live.Id,
              context,
            });
          }
        }
      });

      const inspect = (name: string, context?: string) =>
        docker.container
          .inspect(name, context)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));

      const remove = (name: string, context?: string) =>
        docker.container.stop(name, context).pipe(
          Effect.andThen(docker.container.remove(name, true, context)),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
        );

      // A different container under the managed name is ours only when it
      // carries this resource's Alchemy labels, e.g. after a recreate whose
      // state write was lost. Anything else is a foreign replacement.
      const verifyIdentity = Effect.fn(function* (
        id: string,
        name: string,
        expectedId: string,
        live: Docker.Container,
      ) {
        if (live.Id === expectedId) return;
        if (yield* hasAlchemyTags(id, live.Config.Labels ?? undefined)) return;
        return yield* containerOwnershipConflict(id, name, expectedId, live.Id);
      });

      return Container.Provider.of({
        list: () => Effect.succeed([]),
        lookup: Effect.fn(function* ({ name, context }) {
          const info = yield* inspect(name, context);
          return info ? toContainerAttributes(info, info.Config.Image) : undefined;
        }),

        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const context = dockerContextName(olds.context);
          const name = yield* dockerPhysicalName(id, olds, instanceId);
          const info = yield* inspect(name, context);
          if (!info) return undefined;
          // `olds.image` may be `undefined` when a `creating` row was
          // persisted before upstream Outputs resolved — fall back to the
          // live container's actual image.
          const attrs = toContainerAttributes(
            info,
            olds.image !== undefined ? normalizeImageRef(olds.image) : info.Config.Image,
          );
          if (output) {
            yield* verifyIdentity(id, name, output.id, info);
            return attrs;
          }
          // Without prior state, only adopt a container that carries our
          // branding; anything else is foreign and gated behind `--adopt`.
          const owned = yield* hasAlchemyTags(id, info.Config.Labels ?? undefined);
          return owned ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          // Validate the desired creation settings before any delete-first
          // replacement decision, including Docker context changes.
          const newArgs = yield* makeCreateArgs(id, news, instanceId);
          yield* validateNetworkIdentities(news);
          const contextChanged =
            dockerContextName(olds.context) !== dockerContextName(news.context);
          const oldArgs =
            olds.image !== undefined && !contextChanged
              ? yield* makeCreateArgs(id, olds, instanceId)
              : undefined;
          const mustReplace =
            olds.image !== undefined && (contextChanged || !Equal.equals(oldArgs, newArgs));
          // No-op plans still need to verify the physical container identity.
          // A foreign container can reuse the managed name after deletion.
          if (output) {
            const live = yield* inspect(output.name, dockerContextName(olds.context));
            if (live) yield* verifyIdentity(id, output.name, output.id, live);
            if (!live && !mustReplace) return { action: "update" as const };
          }
          // An Output-valued `image` doesn't survive a `creating`-state
          // round-trip (it deserializes as `undefined`) — without comparable
          // prior create args, let the engine apply its default update logic.
          if (mustReplace) {
            return { action: "replace" as const, deleteFirst: true };
          }
          if (olds.image === undefined) return undefined;
          if (
            !Equal.equals(olds.networks ?? [], news.networks ?? []) ||
            (olds.start ?? false) !== (news.start ?? false)
          ) {
            return { action: "update" as const };
          }
          if (news.networks?.length) {
            const live = yield* inspect(newArgs.name, dockerContextName(news.context));
            if (
              live &&
              (hasImplicitDefaultBridge(live, news) ||
                news.networks.some((network) => !matchesNetworkEndpoint(live, network, network)))
            ) {
              return { action: "update" as const };
            }
          }
          // File-backed inputs can change without changing their paths.
          // Compare their digests against the live config hash.
          if (news.envFiles?.length || isCustomSeccompProfile(news.seccompProfile)) {
            const live = yield* inspect(newArgs.name, dockerContextName(news.context));
            const applied = live?.Config.Labels?.[CREATE_CONFIG_HASH_LABEL];
            if (applied !== undefined && applied !== (yield* desiredConfigHash(newArgs, news))) {
              return { action: "update" as const };
            }
          }
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
          const context = dockerContextName(news.context);
          const args = yield* makeCreateArgs(id, news, instanceId);
          yield* validateNetworkIdentities(news);
          const configHash = yield* desiredConfigHash(args, news);
          // Adoption has output but no olds. In that case the observed
          // container already lives in the desired context.
          const oldContext = olds ? dockerContextName(olds.context) : context;
          const desiredLive = yield* inspect(args.name, context);
          const previous =
            output && (output.name !== args.name || oldContext !== context)
              ? yield* inspect(output.name, oldContext)
              : undefined;
          if (output && desiredLive) {
            yield* verifyIdentity(id, args.name, output.id, desiredLive);
          }
          if (output && previous) {
            yield* verifyIdentity(id, output.name, output.id, previous);
          }
          if (previous) {
            yield* remove(previous.Id, oldContext);
          }
          const live = desiredLive?.Id === previous?.Id ? undefined : desiredLive;

          const oldArgs =
            live?.Config.Labels?.[CREATE_CONFIG_HASH_LABEL] === undefined && olds !== undefined
              ? yield* makeCreateArgs(
                  id,
                  {
                    ...olds,
                    image: olds.image ?? output?.imageRef ?? news.image,
                  },
                  instanceId,
                )
              : undefined;
          const recreate =
            live !== undefined &&
            (live.Config.Labels?.[CREATE_CONFIG_HASH_LABEL] === undefined
              ? (oldArgs !== undefined && !Equal.equals(oldArgs, args)) ||
                normalizeImageId(olds?.image) !== normalizeImageId(news.image) ||
                !matchesLegacyConfig(live, args, news.image) ||
                // Env file contents can't be compared without a label (e.g. an
                // adopted container); recreate once so later edits are tracked.
                (news.envFiles?.length ?? 0) > 0 ||
                isCustomSeccompProfile(news.seccompProfile) ||
                // A legacy/adopted container has no stamped config hash.
                // Do not retain it without proof that requested create-time
                // options (security, resources, namespaces, GPU, etc.) were applied.
                hasUnverifiedCreationOptions(news)
              : live.Config.Labels[CREATE_CONFIG_HASH_LABEL] !== configHash);
          if (recreate) {
            yield* remove(live.Id, context);
          }

          const current = recreate ? undefined : live;
          if (!current) {
            const internalTags = yield* createInternalTags(id);
            const { stdout: containerId } = yield* docker.container.create({
              ...args,
              // Attach directly to the first declared network. Without this,
              // Docker silently adds the default bridge, even for internal-only
              // containers. `none` cannot be used here: Docker forbids
              // connecting additional networks while in none mode.
              ...(news.networkMode === undefined && news.networks?.length
                ? { network: news.networks[0]!.name }
                : {}),
              context,
              label: {
                ...args.label,
                ...internalTags,
                [CREATE_CONFIG_HASH_LABEL]: configHash,
              },
            });
            return yield* Effect.gen(function* () {
              const initiallyAttached =
                news.networkMode !== undefined && news.networks?.length
                  ? yield* docker.container.inspect(containerId, context)
                  : undefined;
              yield* Effect.forEach(
                news.networks ?? [],
                (network, index) =>
                  (news.networkMode === undefined && index === 0) ||
                  (initiallyAttached && findNetworkEndpoint(initiallyAttached, network.name))
                    ? docker.network
                        .disconnect({ network: network.name, container: containerId, context })
                        .pipe(Effect.andThen(connectNetwork(network, containerId, context)))
                    : connectNetwork(network, containerId, context),
                { concurrency: 1 },
              );
              if (news.start) {
                yield* docker.container.start(containerId, context);
              }
              const info = yield* docker.container.inspect(containerId, context);
              return toContainerAttributes(info, args.image);
            }).pipe(
              // A failed attachment happens after docker create but before
              // the engine persists attributes. Do not leave an untracked
              // container occupying the deterministic physical name.
              Effect.onError(() =>
                docker.container.remove(containerId, true, context).pipe(Effect.ignore),
              ),
            );
          }

          yield* reconcileNetworks(current, news, olds);
          if (news.start && current.State.Status !== "running") {
            yield* docker.container.start(current.Id, context);
          } else if (!news.start && current.State.Status === "running") {
            yield* docker.container.stop(current.Id, context);
          }
          return yield* docker.container
            .inspect(current.Id, context)
            .pipe(Effect.map((info) => toContainerAttributes(info, args.image)));
        }),
        delete: Effect.fn(function* ({ id, olds, output }) {
          const context = dockerContextName(olds.context);
          // Remove the recorded container, plus a successor under the same
          // name that carries this resource's labels. Never a foreign one.
          const live = yield* inspect(output.name, context);
          if (
            live &&
            live.Id !== output.id &&
            (yield* hasAlchemyTags(id, live.Config.Labels ?? undefined))
          ) {
            yield* remove(live.Id, context);
          }
          yield* remove(output.id, context);
        }),
      });
    }),
  );

const normalizeImageRef = (image: Container.Image): string =>
  typeof image === "string" ? image : image.imageRef;

const normalizeImageId = (image: Container.Image | undefined) =>
  typeof image === "string" ? undefined : image?.imageId;

type CreateArgs = Parameters<Docker["Service"]["container"]["create"]>[0];

const containerOwnershipConflict = (
  logicalId: string,
  physicalName: string,
  expectedId: string,
  actualId: string,
) =>
  new OwnedBySomeoneElse({
    message:
      `Docker container '${physicalName}' was replaced outside Alchemy: ` +
      `expected ID ${expectedId}, found ${actualId}. Refusing to modify the replacement.`,
    resourceType: "Docker.Container",
    logicalId,
    physicalName,
  });

// Containers created before config hashes were introduced are compared using
// the fields Docker reports without image-default normalization. A subsequent
// create stamps the complete resolved configuration hash.
const matchesLegacyConfig = (live: Docker.Container, desired: CreateArgs, image: Container.Image) =>
  (normalizeImageId(image)
    ? live.Image === normalizeImageId(image)
    : live.Config.Image === desired.image) &&
  (desired.command === undefined || Equal.equals(live.Config.Cmd, desired.command)) &&
  (desired.hostname === undefined || live.Config.Hostname === desired.hostname) &&
  (desired.dns === undefined || Equal.equals(live.HostConfig.Dns ?? [], desired.dns)) &&
  (desired["dns-search"] === undefined ||
    Equal.equals(live.HostConfig.DnsSearch ?? [], desired["dns-search"])) &&
  (desired["dns-option"] === undefined ||
    Equal.equals(live.HostConfig.DnsOptions ?? [], desired["dns-option"])) &&
  Object.entries(desired.env ?? {}).every(([key, value]) =>
    live.Config.Env?.includes(`${key}=${value}`),
  );

const makeCreateArgs = (id: string, news: ContainerProps, instanceId: string) =>
  dockerPhysicalName(id, news, instanceId).pipe(
    Effect.tap(() => validateContainerOptions(news)),
    Effect.map((name): Parameters<Docker["Service"]["container"]["create"]>[0] => ({
      name,
      image: normalizeImageRef(news.image),
      command: news.command,
      ...(news.entrypoint !== undefined ? { entrypoint: news.entrypoint } : {}),
      ...(news.workingDirectory !== undefined ? { workdir: news.workingDirectory } : {}),
      ...(news.platform !== undefined ? { platform: news.platform } : {}),
      env: normalizeEnvironment(news.environment),
      "env-file": news.envFiles?.length ? news.envFiles : undefined,
      volume: news.volumes?.map(
        (v) => `${v.hostPath}:${v.containerPath}${v.readOnly ? ":ro" : ""}`,
      ),
      p: news.ports?.map((port) => {
        const target = `${port.internal}/${port.protocol ?? "tcp"}`;
        // `external: 0` means "any free host port". Docker spells that as a
        // bare container port (`-p 80/tcp`); `-p 0:80/tcp` instead asks for
        // host port 0 literally, which the daemon accepts and then reports
        // back as 0.
        return isRandomHostPort(port.external) ? target : `${port.external}:${target}`;
      }),
      "add-host": news.extraHosts,
      ...(news.hostname !== undefined ? { hostname: news.hostname } : {}),
      ...(news.dns?.length ? { dns: news.dns } : {}),
      ...(news.dnsSearch?.length ? { "dns-search": news.dnsSearch } : {}),
      ...(news.dnsOptions?.length ? { "dns-option": news.dnsOptions } : {}),
      network: normalizeNetworkMode(news.networkMode),
      ...(news.ipcNamespace !== undefined ? { ipc: news.ipcNamespace } : {}),
      ...(news.pidNamespace !== undefined ? { pid: news.pidNamespace } : {}),
      ...(Object.keys(news.sysctls ?? {}).length ? { sysctl: normalizeSysctls(news.sysctls) } : {}),
      "cap-add": normalizeCapabilities(news.capAdd),
      ...(news.capDrop?.length ? { "cap-drop": normalizeCapabilities(news.capDrop) } : {}),
      ...(news.memory !== undefined ? { memory: news.memory } : {}),
      ...(news.sharedMemorySize !== undefined ? { "shm-size": news.sharedMemorySize } : {}),
      ...(news.memorySwap !== undefined ? { "memory-swap": news.memorySwap } : {}),
      ...(news.memoryReservation !== undefined
        ? { "memory-reservation": news.memoryReservation }
        : {}),
      ...(news.cpus !== undefined ? { cpus: news.cpus } : {}),
      ...(news.pidsLimit !== undefined ? { "pids-limit": news.pidsLimit } : {}),
      ...(news.readOnlyRootFilesystem ? { "read-only": true } : {}),
      ...(news.privileged ? { privileged: true } : {}),
      ...(normalizeSecurityOptions(news) ? { "security-opt": normalizeSecurityOptions(news) } : {}),
      ...(news.userNamespace !== undefined ? { userns: news.userNamespace } : {}),
      ...(news.groupAdd?.length ? { "group-add": normalizeGroups(news.groupAdd) } : {}),
      ...(Object.keys(news.ulimits ?? {}).length ? { ulimit: normalizeUlimits(news.ulimits) } : {}),
      ...(news.logDriver !== undefined ? { "log-driver": news.logDriver } : {}),
      ...(Object.keys(news.logOptions ?? {}).length
        ? { "log-opt": normalizeLogOptions(news.logOptions) }
        : {}),
      ...(news.oomScoreAdjustment !== undefined
        ? { "oom-score-adj": news.oomScoreAdjustment }
        : {}),
      ...(news.stopSignal !== undefined ? { "stop-signal": news.stopSignal } : {}),
      ...(news.init ? { init: true } : {}),
      ...(news.user !== undefined ? { user: news.user } : {}),
      ...(news.keepStdinOpen ? { interactive: true } : {}),
      ...(news.allocatePseudoTerminal ? { tty: true } : {}),
      ...(news.gpuDevices !== undefined ? { gpus: news.gpuDevices } : {}),
      ...(news.tmpfs?.length ? { tmpfs: normalizeTmpfs(news.tmpfs) } : {}),
      device: normalizeDevices(news.devices),
      restart: news.restart ?? "no",
      label: news.labels,
      "stop-timeout": toSeconds(news.stopTimeout)?.toString(),
      rm: news.removeOnExit ?? false,
      ...(news.healthcheck
        ? {
            "health-cmd": healthcheckCommand(news.healthcheck.cmd),
            // Only when set: an always-present key would change every
            // container's config hash and recreate it on upgrade.
            ...(isHealthcheckDisabled(news.healthcheck.cmd) ? { "no-healthcheck": true } : {}),
            "health-interval": normalizeDuration(news.healthcheck.interval),
            "health-timeout": normalizeDuration(news.healthcheck.timeout),
            "health-retries": news.healthcheck.retries ?? 0,
            "health-start-period": normalizeDuration(news.healthcheck.startPeriod),
            "health-start-interval": normalizeDuration(news.healthcheck.startInterval),
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
  networkMode: info.HostConfig.NetworkMode,
  capAdd: info.HostConfig.CapAdd ?? undefined,
  devices: info.HostConfig.Devices?.map((device) => ({
    hostPath: device.PathOnHost,
    containerPath: device.PathInContainer,
    permissions: device.CgroupPermissions,
  })),
});

const normalizeNetworkMode = (mode: Container.NetworkMode | undefined): string | undefined =>
  mode === undefined ? undefined : typeof mode === "string" ? mode : `container:${mode.container}`;

const parseIpAddress = Schema.decodeUnknownResult(Schema.IpAddressFromString);
const parseIpv4Address = Schema.decodeUnknownResult(Schema.Ipv4AddressFromString);
const parseIpv6Address = Schema.decodeUnknownResult(Schema.Ipv6AddressFromString);

const sameIpAddress = (left: string | undefined, right: string | undefined): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  const a = parseIpAddress(left);
  const b = parseIpAddress(right);
  return Result.isSuccess(a) && Result.isSuccess(b) && Equal.equals(a.success, b.success);
};

type InspectedNetworkEndpoint = NonNullable<
  Docker.Container["NetworkSettings"]["Networks"]
>[string];

/** Docker indexes endpoints by network name, even when the declaration used its ID. */
const findNetworkEndpoint = (
  live: Docker.Container,
  network: string,
): InspectedNetworkEndpoint | undefined => {
  const attached = live.NetworkSettings.Networks;
  return (
    attached?.[network] ??
    Object.values(attached ?? {}).find((entry) => entry.NetworkID === network)
  );
};

/** A managed network may be referenced by name or by the same Docker network ID. */
const referencesSameNetwork = (live: Docker.Container, left: string, right: string): boolean => {
  if (left === right) return true;
  const leftEndpoint = findNetworkEndpoint(live, left);
  const rightEndpoint = findNetworkEndpoint(live, right);
  return (
    leftEndpoint !== undefined &&
    rightEndpoint !== undefined &&
    leftEndpoint.NetworkID === rightEndpoint.NetworkID
  );
};

const hasImplicitDefaultBridge = (live: Docker.Container, news: ContainerProps): boolean =>
  news.networkMode === undefined &&
  (news.networks?.length ?? 0) > 0 &&
  (live.HostConfig.NetworkMode === "default" || live.HostConfig.NetworkMode === "bridge") &&
  findNetworkEndpoint(live, "bridge") !== undefined &&
  !(news.networks ?? []).some((network) => referencesSameNetwork(live, network.name, "bridge"));

/** Compare only declared endpoint settings: Docker adds its own aliases and addresses. */
const matchesNetworkEndpoint = (
  live: Docker.Container,
  desired: Container.NetworkMapping,
  previous?: Container.NetworkMapping,
): boolean => {
  const entry = findNetworkEndpoint(live, desired.name);
  if (!entry) return false;

  const actualAliases = new Set(entry.Aliases ?? []);
  const desiredAliases = new Set(desired.aliases ?? []);
  if ([...desiredAliases].some((alias) => !actualAliases.has(alias))) return false;
  if (
    (previous?.aliases ?? []).some(
      (alias) => !desiredAliases.has(alias) && actualAliases.has(alias),
    )
  ) {
    return false;
  }

  // An explicit IPAM reservation differs from a coincidentally identical
  // Docker-assigned address. When removing a reservation, reattach once so
  // Docker can assign the address itself.
  if (desired.ipv4Address !== undefined) {
    if (
      !sameIpAddress(entry.IPAddress, desired.ipv4Address) ||
      !sameIpAddress(entry.IPAMConfig?.IPv4Address, desired.ipv4Address)
    )
      return false;
  } else if (previous?.ipv4Address !== undefined) {
    return false;
  }
  if (desired.ipv6Address !== undefined) {
    if (
      !sameIpAddress(entry.GlobalIPv6Address, desired.ipv6Address) ||
      !sameIpAddress(entry.IPAMConfig?.IPv6Address, desired.ipv6Address)
    )
      return false;
  } else if (previous?.ipv6Address !== undefined) {
    return false;
  }
  if ((entry.GwPriority ?? 0) !== (desired.gatewayPriority ?? 0)) return false;
  const currentOpts = entry.DriverOpts ?? {};
  for (const [key, value] of Object.entries(desired.driverOpts ?? {})) {
    if (currentOpts[key] !== value) return false;
  }
  for (const key of Object.keys(previous?.driverOpts ?? {})) {
    if (!(key in (desired.driverOpts ?? {})) && key in currentOpts) return false;
  }
  return true;
};

const normalizeCapabilities = (capAdd: string[] | undefined): string[] | undefined => {
  if (!capAdd?.length) return undefined;
  return [...new Set(capAdd.map((capability) => capability.trim()).filter(Boolean))].sort();
};

const isCustomSeccompProfile = (profile: string | undefined): profile is string =>
  profile !== undefined && profile !== "builtin" && profile !== "unconfined";

const normalizeSecurityOptions = (props: ContainerProps): string[] | undefined => {
  const options = [
    ...(props.noNewPrivileges ? ["no-new-privileges"] : []),
    ...(props.seccompProfile ? [`seccomp=${props.seccompProfile}`] : []),
    ...(props.appArmorProfile ? [`apparmor=${props.appArmorProfile}`] : []),
  ];
  return options.length ? options : undefined;
};

const normalizeGroups = (groups: string[]): string[] =>
  [...new Set(groups.map((group) => group.trim()))].sort();

const normalizeUlimits = (limits: ContainerProps["ulimits"]): string[] =>
  Object.entries(limits ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, { soft, hard }]) => `${name}=${soft}:${hard}`);

const normalizeLogOptions = (options: ContainerProps["logOptions"]): string[] =>
  Object.entries(options ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);

const normalizeSysctls = (values: ContainerProps["sysctls"]): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );

/** Positive Docker go-units byte sizes, e.g. 256m, 1.5GiB or 512 kb. */
const isPositiveDockerByteSize = (value: string): boolean => {
  if (value !== value.trim()) return false;
  const magnitude = parseDockerByteSizeMagnitude(value);
  return magnitude !== undefined && magnitude > 0;
};

const normalizeTmpfs = (mounts: Container.TmpfsMount[]): string[] =>
  [...mounts]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, size, mode }) => {
      const options = [
        ...(size !== undefined ? [`size=${size}`] : []),
        ...(mode !== undefined ? [`mode=${mode.toString(8)}`] : []),
      ];
      return options.length > 0 ? `${path}:${options.join(",")}` : path;
    });

// Older/adopted containers without a config hash can match image defaults
// despite missing requested settings. Keep this explicit allowlist complement
// separate from makeCreateArgs: the legacy comparison proves only selected
// fields, while default/unset options must not roll existing containers.
const hasUnverifiedCreationOptions = (props: ContainerProps): boolean =>
  (props.capDrop?.length ?? 0) > 0 ||
  props.memory !== undefined ||
  props.sharedMemorySize !== undefined ||
  props.memorySwap !== undefined ||
  props.memoryReservation !== undefined ||
  props.cpus !== undefined ||
  props.pidsLimit !== undefined ||
  props.readOnlyRootFilesystem === true ||
  props.noNewPrivileges === true ||
  props.privileged === true ||
  props.entrypoint !== undefined ||
  props.workingDirectory !== undefined ||
  props.platform !== undefined ||
  props.ipcNamespace !== undefined ||
  props.pidNamespace !== undefined ||
  Object.keys(props.sysctls ?? {}).length > 0 ||
  props.gpuDevices !== undefined ||
  props.keepStdinOpen === true ||
  props.allocatePseudoTerminal === true ||
  props.seccompProfile !== undefined ||
  props.appArmorProfile !== undefined ||
  props.userNamespace !== undefined ||
  (props.groupAdd?.length ?? 0) > 0 ||
  Object.keys(props.ulimits ?? {}).length > 0 ||
  props.logDriver !== undefined ||
  Object.keys(props.logOptions ?? {}).length > 0 ||
  props.oomScoreAdjustment !== undefined ||
  props.stopSignal !== undefined ||
  props.init === true ||
  props.user !== undefined ||
  (props.tmpfs?.length ?? 0) > 0;

const normalizeDevices = (devices: Container.DeviceMapping[] | undefined): string[] | undefined => {
  if (!devices?.length) return undefined;
  const normalized = devices.map(
    (device) => `${device.hostPath}:${device.containerPath}:${device.permissions ?? "rwm"}`,
  );
  return [...new Set(normalized)].sort();
};

/**
 * Raised before Docker is called when a container's options cannot be
 * combined, e.g. sharing another container's network namespace while
 * publishing ports.
 */
export class InvalidContainerOptions extends Data.TaggedError("InvalidContainerOptions")<{
  /** Property path in the declared Docker.Container configuration. */
  readonly path: string;
  readonly message: string;
}> {}

const invalidContainerOption = (path: string, detail: string) =>
  Effect.fail(new InvalidContainerOptions({ path, message: `Docker.Container ${path} ${detail}` }));

const invalidContainerMapEntry = (entries: Record<string, string> | undefined) =>
  Object.entries(entries ?? {}).find(
    ([key, value]) => !key.trim() || key.includes("=") || !value.trim(),
  );

const validateContainerValues = (news: ContainerProps) => {
  if (Object.keys(news.labels ?? {}).some((key) => key.startsWith("alchemy::"))) {
    return invalidContainerOption("labels", "must not use the reserved alchemy:: prefix");
  }
  // The CLI formatter omits empty strings. Reject them instead of silently
  // dropping user-specified resource and security restrictions.
  for (const option of [
    "memory",
    "memorySwap",
    "memoryReservation",
    "sharedMemorySize",
    "user",
    "entrypoint",
    "workingDirectory",
    "platform",
    "ipcNamespace",
    "pidNamespace",
    "gpuDevices",
    "seccompProfile",
    "appArmorProfile",
    "userNamespace",
    "logDriver",
    "stopSignal",
    "hostname",
  ] as const) {
    if (news[option] !== undefined && news[option].trim().length === 0) {
      return invalidContainerOption(option, "cannot be empty");
    }
  }
  // Reject structurally invalid create-time settings during plan/diff, before
  // the engine deletes an existing container to replace it. Docker accepts
  // --shm-size 0 but silently falls back to its default shared-memory size.
  if (news.sharedMemorySize !== undefined && !isPositiveDockerByteSize(news.sharedMemorySize)) {
    return invalidContainerOption(
      "sharedMemorySize",
      "must be a positive Docker byte size, e.g. 256m or 1.5GiB",
    );
  }
  if (
    news.workingDirectory !== undefined &&
    !news.workingDirectory.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(news.workingDirectory)
  ) {
    return invalidContainerOption("workingDirectory", "must be an absolute path");
  }
  if (
    news.pidNamespace !== undefined &&
    news.pidNamespace !== "host" &&
    !/^container:[^\s:]+$/.test(news.pidNamespace)
  ) {
    return invalidContainerOption(
      "pidNamespace",
      "must be host or container:<id> (omit for private)",
    );
  }
  if (
    news.ipcNamespace !== undefined &&
    !["none", "private", "shareable", "host"].includes(news.ipcNamespace) &&
    !/^container:[^\s:]+$/.test(news.ipcNamespace)
  ) {
    return invalidContainerOption(
      "ipcNamespace",
      "must be none, private, shareable, host or container:<id>",
    );
  }
  if (
    news.sharedMemorySize !== undefined &&
    news.ipcNamespace !== undefined &&
    news.ipcNamespace !== "private" &&
    news.ipcNamespace !== "shareable"
  ) {
    return invalidContainerOption("sharedMemorySize", "requires private or shareable ipcNamespace");
  }
  for (const [index, value] of (news.dns ?? []).entries()) {
    if (Result.isFailure(parseIpAddress(value))) {
      return invalidContainerOption(`dns[${index}]`, "must be an IPv4 or IPv6 address");
    }
  }
  for (const [option, values] of [
    ["dnsSearch", news.dnsSearch],
    ["dnsOptions", news.dnsOptions],
  ] as const) {
    if (values?.some((value) => !value.trim())) {
      return invalidContainerOption(option, "cannot contain empty values");
    }
  }
  return Effect.void;
};

const validateContainerNetworks = (news: ContainerProps) => {
  const connectedNetworks = new Set<string>();
  for (const [index, network] of (news.networks ?? []).entries()) {
    const field = `networks[${index}]`;
    if (!network.name.trim() || connectedNetworks.has(network.name)) {
      return invalidContainerOption(`${field}.name`, "must be nonempty and unique");
    }
    connectedNetworks.add(network.name);
    if (network.aliases?.some((alias) => !alias.trim())) {
      return invalidContainerOption(`${field}.aliases`, "cannot contain empty aliases");
    }
    if (
      network.ipv4Address !== undefined &&
      Result.isFailure(parseIpv4Address(network.ipv4Address))
    ) {
      return invalidContainerOption(`${field}.ipv4Address`, "must be a valid IPv4 address");
    }
    if (
      network.ipv6Address !== undefined &&
      Result.isFailure(parseIpv6Address(network.ipv6Address))
    ) {
      return invalidContainerOption(`${field}.ipv6Address`, "must be a valid IPv6 address");
    }
    if (network.gatewayPriority !== undefined && !Number.isSafeInteger(network.gatewayPriority)) {
      return invalidContainerOption(`${field}.gatewayPriority`, "must be an integer");
    }
    const invalidDriverOption = invalidContainerMapEntry(network.driverOpts);
    if (invalidDriverOption) {
      return invalidContainerOption(
        `${field}.driverOpts`,
        `contains an invalid entry: ${invalidDriverOption[0]}`,
      );
    }
  }
  return Effect.void;
};

const validateContainerRuntime = (news: ContainerProps) => {
  if (news.capDrop?.some((capability) => capability.trim().length === 0)) {
    return invalidContainerOption("capDrop", "cannot contain empty capabilities");
  }
  if (news.groupAdd?.some((group) => group.trim().length === 0)) {
    return invalidContainerOption("groupAdd", "cannot contain empty groups");
  }
  for (const [name, limit] of Object.entries(news.ulimits ?? {})) {
    if (
      !/^[a-z][a-z0-9_-]*$/.test(name) ||
      !Number.isSafeInteger(limit.soft) ||
      !Number.isSafeInteger(limit.hard) ||
      limit.soft < -1 ||
      limit.hard < -1 ||
      (limit.hard !== -1 && (limit.soft === -1 || limit.soft > limit.hard))
    ) {
      return invalidContainerOption("ulimits", `contains an invalid soft/hard limit for ${name}`);
    }
  }
  for (const [path, options, noun] of [
    ["logOptions", news.logOptions, "option"],
    ["sysctls", news.sysctls, "setting"],
  ] as const) {
    const invalidEntry = invalidContainerMapEntry(options);
    if (invalidEntry) {
      return invalidContainerOption(path, `contains an invalid ${noun}: ${invalidEntry[0]}`);
    }
  }
  if (
    news.oomScoreAdjustment !== undefined &&
    (!Number.isInteger(news.oomScoreAdjustment) ||
      news.oomScoreAdjustment < -1000 ||
      news.oomScoreAdjustment > 1000)
  ) {
    return invalidContainerOption("oomScoreAdjustment", "must be an integer from -1000 to 1000");
  }
  if (news.memorySwap !== undefined && news.memory === undefined) {
    return invalidContainerOption("memorySwap", "requires memory to be set");
  }
  if (news.cpus !== undefined && (!Number.isFinite(news.cpus) || news.cpus <= 0)) {
    return invalidContainerOption("cpus", "must be a finite, positive number");
  }
  if (
    news.pidsLimit !== undefined &&
    (!Number.isInteger(news.pidsLimit) || (news.pidsLimit <= 0 && news.pidsLimit !== -1))
  ) {
    return invalidContainerOption("pidsLimit", "must be a positive integer or -1 (unlimited)");
  }
  if (
    isContainerNetworkMode(news.networkMode) &&
    ((news.ports?.length ?? 0) > 0 || (news.networks?.length ?? 0) > 0)
  ) {
    return invalidContainerOption(
      "networkMode.container",
      "cannot be combined with ports or networks",
    );
  }
  if (
    (news.networkMode === "host" || news.networkMode === "none") &&
    (news.networks?.length ?? 0) > 0
  ) {
    return invalidContainerOption(
      "networkMode",
      `${news.networkMode} cannot be combined with networks`,
    );
  }
  // Docker forbids these creation flags when the network namespace belongs
  // to another container; reject them before a delete-first replacement.
  if (
    isContainerNetworkMode(news.networkMode) &&
    (news.hostname !== undefined ||
      (news.dns?.length ?? 0) > 0 ||
      (news.dnsSearch?.length ?? 0) > 0 ||
      (news.dnsOptions?.length ?? 0) > 0 ||
      (news.extraHosts?.length ?? 0) > 0)
  ) {
    return invalidContainerOption(
      "networkMode.container",
      "cannot be combined with hostname, dns, dnsSearch, dnsOptions or extraHosts",
    );
  }
  return Effect.void;
};

const validateContainerMounts = (news: ContainerProps) => {
  const targets = new Set<string>();
  for (const device of news.devices ?? []) {
    if (targets.has(device.containerPath)) {
      return invalidContainerOption(
        "devices",
        `contain conflicting target path ${device.containerPath}`,
      );
    }
    targets.add(device.containerPath);
  }
  const tmpfsTargets = new Set<string>();
  for (const mount of news.tmpfs ?? []) {
    if (mount.size !== undefined && mount.size.trim().length === 0) {
      return invalidContainerOption("tmpfs", `size cannot be empty for ${mount.path}`);
    }
    if (!mount.path.startsWith("/") || mount.path.includes(":") || mount.path.includes(",")) {
      return invalidContainerOption("tmpfs", `target must be an absolute path: ${mount.path}`);
    }
    if (tmpfsTargets.has(mount.path)) {
      return invalidContainerOption("tmpfs", `contains duplicate target ${mount.path}`);
    }
    if (
      mount.mode !== undefined &&
      (!Number.isInteger(mount.mode) || mount.mode < 0 || mount.mode > 0o7777)
    ) {
      return invalidContainerOption("tmpfs", `mode is not a valid POSIX mode for ${mount.path}`);
    }
    tmpfsTargets.add(mount.path);
  }
  return Effect.void;
};

const validateContainerOptions = (news: ContainerProps) =>
  Effect.gen(function* () {
    yield* validateContainerValues(news);
    yield* validateContainerNetworks(news);
    yield* validateContainerRuntime(news);
    yield* validateContainerMounts(news);
  });

const isContainerNetworkMode = (mode: Container.NetworkMode | undefined): boolean =>
  typeof mode === "string" ? mode.startsWith("container:") : mode !== undefined;

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
  for (const [internal, bindings] of Object.entries(info.HostConfig.PortBindings ?? {})) {
    const port = boundHostPort(bindings);
    if (port !== undefined) ports[internal] = port;
  }
  for (const [internal, bindings] of Object.entries(info.NetworkSettings.Ports ?? {})) {
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

const normalizeDuration = (input: Duration.Input | undefined): string | undefined => {
  if (!input) return undefined;
  const duration = Duration.fromInputUnsafe(input);
  // Docker parses `--health-*` durations with Go's `time.ParseDuration`, which
  // requires a unit suffix — a bare nanosecond count is rejected with "missing
  // unit in duration". `ns` is the lossless Go-duration rendering of the nanos.
  return `${Duration.toNanosUnsafe(duration).toString()}ns`;
};
