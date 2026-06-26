import * as Docker from "@/Docker";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { describe } from "vitest";

const dockerDaemonOk =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
  adopt: true,
});

test.provider("diff replaces a container when its image changes", () =>
  Effect.gen(function* () {
    const containerProvider = yield* Provider.findProvider(Docker.Container);
    const containerDiff = yield* containerProvider.diff!({
      id: "web",
      instanceId: "instance",
      olds: { name: "web", image: "nginx:alpine" },
      news: { name: "web", image: "nginx:1.27-alpine" },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "web",
        name: "web",
        status: "created",
        createdAt: 0,
        imageRef: "nginx:alpine",
        ports: {},
      },
    });
    expect(containerDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

describe("Docker.Container", { concurrent: false }, () => {
  test.provider.skipIf(!dockerDaemonOk)(
    "publishes and inspects bound host ports",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const hostPort = yield* freeHostPort;
        // No explicit name: rely on the engine-generated physical name.
        const container = yield* stack.deploy(
          Docker.Container("nginx-container", {
            image: "nginx:alpine",
            ports: [{ external: hostPort, internal: 80 }],
            start: true,
          }),
        );
        expect(container.name.length).toBeGreaterThan(0);
        expect(container.status).toBe("running");

        const runtime = yield* docker.container.inspect(container.name);
        expect(runtime.NetworkSettings.Ports).toMatchObject({
          "80/tcp": [
            { HostIp: "0.0.0.0", HostPort: `${hostPort}` },
            { HostIp: "::", HostPort: `${hostPort}` },
          ],
        });
      }),
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "creates a stopped container when start is false",
    (stack) =>
      Effect.gen(function* () {
        const container = yield* stack.deploy(
          Docker.Container("stopped-container", {
            image: "nginx:alpine",
            start: false,
          }),
        );
        expect(container.status).toBe("created");
        expect(container.imageRef).toBe("nginx:alpine");
      }),
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "updates network aliases without replacing the container",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        // No explicit names: the engine generates stable physical names that
        // stay constant across the two deploys (same instance id).
        const deployWithAlias = (alias: string) =>
          stack.deploy(
            Effect.gen(function* () {
              const network = yield* Docker.Network("alias-network");
              const container = yield* Docker.Container("alias-container", {
                image: "nginx:alpine",
                networks: [{ name: network.name, aliases: [alias] }],
              });
              return { container, network };
            }),
          );

        const first = yield* deployWithAlias("old-alias");
        const second = yield* deployWithAlias("new-alias");
        expect(second.container.id).toBe(first.container.id);

        const info = yield* docker.container.inspect(second.container.name);
        const aliases =
          info?.NetworkSettings.Networks?.[second.network.name]?.Aliases ?? [];
        expect(aliases).toContain("new-alias");
        expect(aliases).not.toContain("old-alias");
      }),
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "replaces the container when published ports change",
    (stack) =>
      Effect.gen(function* () {
        const firstPort = yield* freeHostPort;
        const secondPort = yield* freeHostPort;
        const first = yield* stack.deploy(
          Docker.Container("ported-container", {
            image: "nginx:alpine",
            ports: [{ external: firstPort, internal: 80 }],
          }),
        );
        const second = yield* stack.deploy(
          Docker.Container("ported-container", {
            image: "nginx:alpine",
            ports: [{ external: secondPort, internal: 80 }],
          }),
        );
        expect(second.id).not.toBe(first.id);
        expect(second.ports["80/tcp"]).toBe(secondPort);
      }),
  );
});

const freeHostPort = Effect.promise(
  () =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port =
          typeof address === "object" && address ? address.port : undefined;
        server.close((error) => {
          if (error) {
            reject(error);
          } else if (port) {
            resolve(port);
          } else {
            reject(new Error("Failed to allocate a free host port"));
          }
        });
      });
    }),
);
