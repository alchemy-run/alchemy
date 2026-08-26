import {
  closeDockerHostGatewayForwards,
  dockerHostGatewayAddresses,
  exposeLoopbackPortsToDockerHostGateway,
  isLoopbackHost,
  isPrivateIpv4,
} from "@/Local/DockerHostGateway";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Net from "node:net";

const listen = (host: string, port: number) =>
  Effect.callback<Net.Server, Error>((resume) => {
    const server = Net.createServer((socket) => {
      socket.write("pong");
      socket.end();
    });
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(port, host, () => resume(Effect.succeed(server)));
  });

const close = (server: Net.Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });

const readOnce = (host: string, port: number) =>
  Effect.callback<string, Error>((resume) => {
    const socket = Net.connect({ host, port }, () => undefined);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () =>
      resume(Effect.succeed(Buffer.concat(chunks).toString())),
    );
    socket.on("error", (error) => resume(Effect.fail(error)));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resume(Effect.fail(new Error(`timeout connecting to ${host}:${port}`)));
    });
  });

describe("Docker host-gateway loopback expose", () => {
  it("recognizes loopback and localhost-looking hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("host.docker.localhost")).toBe(true);
    expect(isLoopbackHost("db.example.com")).toBe(false);
    expect(
      isLoopbackHost("ep-cool-name-123456-pooler.us-east-1.aws.neon.tech"),
    ).toBe(false);
    expect(isLoopbackHost("xxxx.pg.psdb.cloud")).toBe(false);
    expect(isLoopbackHost("aws.connect.psdb.cloud")).toBe(false);
  });

  it("treats Docker and RFC1918 addresses as host-gateway candidates", () => {
    expect(isPrivateIpv4("172.17.0.1")).toBe(true);
    expect(isPrivateIpv4("172.18.0.1")).toBe(true);
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("192.168.1.1")).toBe(true);
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateIpv4("127.0.0.1")).toBe(false);
  });

  it.effect(
    "forwards Docker bridge traffic to a process bound only on 127.0.0.1",
    () => {
      let port: number | undefined;
      let server: Net.Server | undefined;
      return Effect.gen(function* () {
        const gateways = yield* Effect.sync(() => dockerHostGatewayAddresses());
        server = yield* listen("127.0.0.1", 0);
        const address = server.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.fail(new Error("expected tcp address"));
        }
        port = address.port;
        yield* exposeLoopbackPortsToDockerHostGateway([port]);

        expect(yield* readOnce("127.0.0.1", port)).toBe("pong");

        // Native Linux Docker: host-gateway is typically 172.17.0.1, and a
        // 127.0.0.1 listener is invisible from the container. Connecting
        // via a 172.16/12 address is the #1334 failure mode. Other RFC1918
        // addresses (LAN, VPN) may not be self-reachable, so skip them.
        for (const gateway of gateways) {
          const [a] = gateway.split(".").map(Number);
          if (a !== 172) continue;
          expect(yield* readOnce(gateway, port)).toBe("pong");
        }
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (port !== undefined) {
              yield* closeDockerHostGatewayForwards([port]);
            }
            if (server !== undefined) yield* close(server);
          }),
        ),
      );
    },
  );
});
