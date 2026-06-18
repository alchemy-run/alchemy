import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Docker from "@/Docker";
import { inspectContainer, runDockerCommand } from "@/Docker/DockerApi";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { describe } from "vitest";

const dockerDaemonOk =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

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

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
  adopt: true,
});

const { test: nonAdoptTest } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );

test.provider("provider diff canaries for replacements and registry refs", () =>
  Effect.gen(function* () {
    const volumeProvider = yield* Provider.findProvider(Docker.Volume);
    const networkProvider = yield* Provider.findProvider(Docker.Network);
    const imageProvider = yield* Provider.findProvider(Docker.Image);

    const volumeDiff = yield* volumeProvider.diff!({
      id: "data",
      instanceId: "instance",
      olds: { name: "data", labels: { usage: "old" } },
      news: { name: "data", labels: { usage: "new" } },
      oldBindings: [],
      newBindings: [],
      output: undefined,
    });
    expect(volumeDiff).toEqual({ action: "replace", deleteFirst: true });

    const networkDiff = yield* networkProvider.diff!({
      id: "app",
      instanceId: "instance",
      olds: { name: "app", labels: { usage: "old" } },
      news: { name: "app", labels: { usage: "new" } },
      oldBindings: [],
      newBindings: [],
      output: undefined,
    });
    expect(networkDiff).toEqual({ action: "replace", deleteFirst: true });

    const imageDiff = yield* imageProvider.diff!({
      id: "app-image",
      instanceId: "instance",
      olds: {
        image: "acme/app:base",
        tag: "latest",
        registry: {
          server: "ghcr.io",
          username: "octocat",
          password: Redacted.make("token"),
        },
      },
      news: {
        image: "acme/app:base",
        tag: "latest",
        registry: {
          server: "ghcr.io",
          username: "octocat",
          password: Redacted.make("token"),
        },
      },
      oldBindings: [],
      newBindings: [],
      output: {
        kind: "Image",
        name: "ghcr.io/acme/app",
        imageRef: "ghcr.io/acme/app:latest",
        tag: "latest",
        builtAt: Date.now(),
      },
    });
    expect(imageDiff).toBeUndefined();
  }),
);

describe.sequential("Docker resources", () => {
  nonAdoptTest.provider.skipIf(!dockerDaemonOk)(
    "network refuses pre-existing Docker network unless explicitly adopted",
    (stack) =>
      Effect.gen(function* () {
        const networkName = "alchemy-test-network-adoption";
        yield* runDockerCommand(["network", "rm", networkName]).pipe(
          Effect.ignore,
        );
        yield* runDockerCommand(["network", "create", networkName]);
        try {
          const error = yield* stack
            .deploy(
              Effect.gen(function* () {
                return yield* Docker.Network("existing-network", {
                  name: networkName,
                });
              }),
            )
            .pipe(
              Effect.as(undefined),
              Effect.catchCause((cause) =>
                Effect.succeed(findOwnedError(cause)),
              ),
            );
          expect(error).toBeInstanceOf(OwnedBySomeoneElse);

          const network = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Docker.Network("existing-network", {
                name: networkName,
              }).pipe(adopt(true));
            }),
          );
          expect(network.name).toBe(networkName);
          expect(network.id.length).toBeGreaterThan(0);
        } finally {
          yield* stack.destroy().pipe(Effect.ignore);
          yield* runDockerCommand(["network", "rm", networkName]).pipe(
            Effect.ignore,
          );
        }
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "network adopts an existing same-name Docker network with stack adoption",
    (stack) =>
      Effect.gen(function* () {
        const networkName = `alchemy-test-network-${Date.now()}`;
        yield* runDockerCommand(["network", "create", networkName]);
        try {
          const network = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Docker.Network("existing-network", {
                name: networkName,
              });
            }),
          );
          expect(network.name).toBe(networkName);
          expect(network.id.length).toBeGreaterThan(0);
        } finally {
          yield* stack.destroy().pipe(Effect.ignore);
          yield* runDockerCommand(["network", "rm", networkName]).pipe(
            Effect.ignore,
          );
        }
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "volume adopts an existing Docker volume",
    (stack) =>
      Effect.gen(function* () {
        const volumeName = `alchemy-test-volume-${Date.now()}`;
        yield* runDockerCommand(["volume", "create", volumeName]);
        try {
          const volume = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Docker.Volume("existing-volume", {
                name: volumeName,
              });
            }),
          );
          expect(volume.name).toBe(volumeName);
          expect(volume.id).toBe(volumeName);
          expect(volume.driver).toBe("local");
        } finally {
          yield* stack.destroy().pipe(Effect.ignore);
          yield* runDockerCommand(["volume", "rm", volumeName]).pipe(
            Effect.ignore,
          );
        }
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "image string source pulls before tagging when the source tag is absent",
    (stack) =>
      Effect.gen(function* () {
        const sourceRef = "hello-world:latest";
        const targetTag = "alchemy-test-remote-source";
        const targetRef = `hello-world:${targetTag}`;
        yield* runDockerCommand(["rmi", "-f", targetRef, sourceRef]).pipe(
          Effect.ignore,
        );
        try {
          const image = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Docker.Image("remote-source-image", {
                image: sourceRef,
                tag: targetTag,
              });
            }),
          );
          expect(image.imageRef).toBe(targetRef);
          expect(image.imageId?.length).toBeGreaterThan(0);
        } finally {
          yield* stack.destroy().pipe(Effect.ignore);
          yield* runDockerCommand(["rmi", "-f", targetRef, sourceRef]).pipe(
            Effect.ignore,
          );
        }
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "image builds a tiny Dockerfile",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-docker-image-",
        });
        const imageName = `alchemy-test-image-${Date.now()}`;
        try {
          yield* fs.writeFileString(
            path.join(root, "Dockerfile"),
            "FROM scratch\nLABEL alchemy.test=true\n",
          );
          const image = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Docker.Image("tiny-image", {
                name: imageName,
                tag: "latest",
                build: { context: root },
              });
            }),
          );
          expect(image.imageRef).toBe(`${imageName}:latest`);
          expect(image.imageId?.length).toBeGreaterThan(0);
          expect(image.contextHash?.length).toBeGreaterThan(0);
        } finally {
          yield* stack.destroy().pipe(Effect.ignore);
          yield* runDockerCommand(["rmi", "-f", `${imageName}:latest`]).pipe(
            Effect.ignore,
          );
          yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
        }
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "remote image pulls a Docker image reference",
    (stack) =>
      Effect.gen(function* () {
        const image = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Docker.RemoteImage("remote-nginx", {
              name: "nginx",
              tag: "alpine",
              alwaysPull: false,
            });
          }),
        );
        expect(image.imageRef).toBe("nginx:alpine");
        expect(image.imageId?.length).toBeGreaterThan(0);
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "container inspect returns bound host ports",
    (stack) =>
      Effect.gen(function* () {
        const containerName = `alchemy-test-container-${Date.now()}`;
        const hostPort = yield* freeHostPort;
        try {
          const container = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Docker.Container("nginx-container", {
                name: containerName,
                image: "nginx:alpine",
                ports: [{ external: hostPort, internal: 80 }],
                start: true,
              });
            }),
          );
          expect(container.name).toBe(containerName);
          expect(container.state).toBe("running");
          const runtime = yield* Docker.Container.inspect(container);
          expect(runtime.ports["80/tcp"]).toBe(hostPort);
        } finally {
          yield* stack.destroy().pipe(Effect.ignore);
          yield* runDockerCommand(["rm", "-f", containerName]).pipe(
            Effect.ignore,
          );
        }
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "container network aliases update without replacing the container",
    (stack) =>
      Effect.gen(function* () {
        const networkName = `alchemy-test-network-alias-${Date.now()}`;
        const containerName = `alchemy-test-alias-container-${Date.now()}`;
        try {
          const deployWithAlias = (alias: string) =>
            stack.deploy(
              Effect.gen(function* () {
                yield* Docker.Network("alias-network", {
                  name: networkName,
                });
                return yield* Docker.Container("alias-container", {
                  name: containerName,
                  image: "nginx:alpine",
                  networks: [{ name: networkName, aliases: [alias] }],
                });
              }),
            );

          const first = yield* deployWithAlias("old-alias");
          const second = yield* deployWithAlias("new-alias");
          expect(second.id).toBe(first.id);

          const info = yield* inspectContainer(containerName);
          const aliases =
            info?.NetworkSettings.Networks?.[networkName]?.Aliases ?? [];
          expect(aliases).toContain("new-alias");
          expect(aliases).not.toContain("old-alias");
        } finally {
          yield* stack.destroy().pipe(Effect.ignore);
          yield* runDockerCommand(["rm", "-f", containerName]).pipe(
            Effect.ignore,
          );
          yield* runDockerCommand(["network", "rm", networkName]).pipe(
            Effect.ignore,
          );
        }
      }),
    { timeout: 120000 },
  );
});
