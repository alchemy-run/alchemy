import * as Effect from "effect/Effect";
import * as Net from "node:net";
import * as Os from "node:os";

/**
 * Hostnames that mean "this machine" in a connection string. Inside a Docker
 * container they resolve to the container itself, so alchemy rewrites them to
 * `host.docker.localhost` and maps that alias to Docker's `host-gateway`.
 *
 * On Docker Desktop the gateway forwards into the host's loopback, so a
 * process bound to `127.0.0.1` is reachable. On native Linux Docker the
 * gateway is the bridge IP (typically `172.17.0.1`) — a SYN to that
 * address never hits a `127.0.0.1` listener. Distros like CachyOS/Arch
 * often rename the bridge or filter INPUT from the docker subnet, so we
 * bind every local RFC1918 address rather than guessing `docker0`.
 * {@link exposeLoopbackPortsToDockerHostGateway} is that forwarder.
 */
export const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "0.0.0.0" ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  hostname.endsWith(".localhost");

const isLoopbackIpv4 = (ip: string) =>
  ip === "127.0.0.1" || ip.startsWith("127.");

const isLinkLocalIpv4 = (ip: string) => ip.startsWith("169.254.");

/**
 * RFC1918 plus Docker's default bridge (`172.16/12`). Native Linux
 * `host-gateway` is one of these — docker0, a `br-*` user bridge, Podman,
 * or a distro that renamed the interface (CachyOS/Arch nftables setups
 * often do not call it `docker0`).
 */
export const isPrivateIpv4 = (ip: string) => {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
};

const LINUX_DOCKER_GATEWAY_FALLBACKS = ["172.17.0.1", "172.18.0.1"] as const;

/**
 * IPv4 addresses a container's `host-gateway` ExtraHosts entry might
 * resolve to. We used to only pick interfaces *named* `docker0`/`br-*`;
 * on CachyOS/Arch the bridge is often a differently named `br-*` *or*
 * still `172.17.0.1` on an interface Node does not label `docker0`, and
 * a 127.0.0.1-only listener then times out exactly as in #1334.
 *
 * Empty-ish on Docker Desktop (macOS/Windows): there is no host-side
 * docker0, and host-gateway already reaches loopback. We still bind any
 * RFC1918 addresses that *are* local so a Linux-like ExtraHosts IP works
 * if one appears.
 */
export const dockerHostGatewayAddresses = (): readonly string[] => {
  const addresses: string[] = [];
  const add = (ip: string) => {
    if (
      !isLoopbackIpv4(ip) &&
      !isLinkLocalIpv4(ip) &&
      !addresses.includes(ip)
    ) {
      addresses.push(ip);
    }
  };
  for (const addrs of Object.values(Os.networkInterfaces())) {
    if (addrs === undefined) continue;
    for (const addr of addrs) {
      const family = String(addr.family);
      if (family !== "IPv4" && family !== "4") continue;
      if (addr.internal) continue;
      if (isPrivateIpv4(addr.address)) add(addr.address);
    }
  }
  // Last resort on native Linux: try Docker's default gateways even if
  // the interface is missing from the snapshot (rootless netns, rename).
  // bind() of a non-local IP fails with EADDRNOTAVAIL and is skipped.
  if (process.platform === "linux") {
    for (const ip of LINUX_DOCKER_GATEWAY_FALLBACKS) add(ip);
  }
  return addresses;
};

const forwardKey = (host: string, port: number) => `${host}:${port}`;

const forwards = new Map<string, Net.Server>();

const isSkippedBindError = (error: unknown) => {
  if (error === null || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return code === "EADDRINUSE" || code === "EADDRNOTAVAIL" || code === "EACCES";
};

const startTcpForward = (
  listenHost: string,
  listenPort: number,
  targetHost: string,
  targetPort: number,
) =>
  Effect.callback<Net.Server, Error>((resume) => {
    let settled = false;
    const settle = (effect: Effect.Effect<Net.Server, Error>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const server = Net.createServer((incoming) => {
      const outgoing = Net.connect({ host: targetHost, port: targetPort });
      incoming.pipe(outgoing);
      outgoing.pipe(incoming);
      const fail = () => {
        incoming.destroy();
        outgoing.destroy();
      };
      incoming.on("error", fail);
      outgoing.on("error", fail);
    });
    server.once("error", (error) => settle(Effect.fail(error)));
    server.listen(
      { host: listenHost, port: listenPort, exclusive: false },
      () => settle(Effect.succeed(server)),
    );
  });

const closeServer = (server: Net.Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });

/**
 * Accept TCP on each Docker host-gateway address for `ports`, forwarding to
 * `127.0.0.1`. No-op when this machine has no Docker bridge (Docker Desktop)
 * or when a port is already bound there.
 *
 * Idempotent per `host:port`. Call {@link closeDockerHostGatewayForwards} to
 * drop the listeners for a given port set (e.g. when a local Prisma database
 * is closed).
 */
export const exposeLoopbackPortsToDockerHostGateway = Effect.fn(function* (
  ports: readonly number[],
) {
  const uniquePorts = [
    ...new Set(ports.filter((port) => Number.isInteger(port) && port > 0)),
  ];
  if (uniquePorts.length === 0) return;
  const hosts = yield* Effect.sync(() => dockerHostGatewayAddresses());
  if (hosts.length === 0) return;

  for (const host of hosts) {
    for (const port of uniquePorts) {
      const key = forwardKey(host, port);
      if (forwards.has(key)) continue;
      const server = yield* startTcpForward(host, port, "127.0.0.1", port).pipe(
        Effect.tap(() =>
          Effect.logDebug(
            `host-gateway forward ${host}:${port} -> 127.0.0.1:${port}`,
          ),
        ),
        Effect.catchIf(isSkippedBindError, (error) =>
          Effect.logDebug(
            `host-gateway forward ${host}:${port} skipped (${String(error)})`,
          ).pipe(Effect.as(undefined)),
        ),
      );
      if (server !== undefined) forwards.set(key, server);
    }
  }
});

/**
 * Stop gateway forwards previously opened for `ports`. Other ports' forwards
 * are left running.
 */
export const closeDockerHostGatewayForwards = Effect.fn(function* (
  ports: readonly number[],
) {
  const uniquePorts = new Set(ports);
  const toClose: Array<{ key: string; server: Net.Server }> = [];
  for (const [key, server] of forwards) {
    const port = Number(key.slice(key.lastIndexOf(":") + 1));
    if (!uniquePorts.has(port)) continue;
    toClose.push({ key, server });
  }
  for (const { key, server } of toClose) {
    forwards.delete(key);
    yield* closeServer(server).pipe(Effect.catch(() => Effect.void));
  }
});
