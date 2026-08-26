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
 * gateway is the bridge IP (`docker0`, typically `172.17.0.1`) — a SYN to
 * that address never hits a `127.0.0.1` listener. Local emulators that we
 * start (e.g. `@prisma/dev`) must therefore also accept connections on the
 * gateway address; {@link exposeLoopbackPortsToDockerHostGateway} does that
 * with a TCP forwarder.
 */
export const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "0.0.0.0" ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  hostname.endsWith(".localhost");

const isDockerBridgeInterface = (name: string) =>
  name === "docker0" ||
  name === "docker_gwbridge" ||
  name.startsWith("br-") ||
  name === "podman0" ||
  name.startsWith("podman");

/**
 * IPv4 addresses Docker's `host-gateway` ExtraHosts entry can resolve to on
 * this machine. Empty on Docker Desktop (macOS/Windows), where the daemon
 * lives in a VM and host-gateway already reaches the host's loopback.
 */
export const dockerHostGatewayAddresses = (): readonly string[] => {
  const addresses: string[] = [];
  for (const [name, addrs] of Object.entries(Os.networkInterfaces())) {
    if (!isDockerBridgeInterface(name) || addrs === undefined) continue;
    for (const addr of addrs) {
      const family = String(addr.family);
      if (
        (family === "IPv4" || family === "4") &&
        !addr.internal &&
        !addresses.includes(addr.address)
      ) {
        addresses.push(addr.address);
      }
    }
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
    server.listen(listenPort, listenHost, () => settle(Effect.succeed(server)));
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
        Effect.catchIf(isSkippedBindError, () => Effect.succeed(undefined)),
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
