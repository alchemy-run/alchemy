import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Docker from "@/Docker";
import { inspectContainerInfo, runDockerCommand } from "@/Docker/DockerApi";
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
        builtAt: 0,
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
        const networkName = "alchemy-test-network-adopt-existing";
        yield* runDockerCommand(["network", "rm", networkName]).pipe(
          Effect.ignore,
        );
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
        const volumeName = "alchemy-test-volume-adopt-existing";
        yield* runDockerCommand(["volume", "rm", volumeName]).pipe(
          Effect.ignore,
        );
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
        let imageRef: string | undefined;
        try {
          yield* fs.writeFileString(
            path.join(root, "Dockerfile"),
            "FROM scratch\nLABEL alchemy.test=true\n",
          );
          const image = yield* stack.deploy(
            Effect.gen(function* () {
              // No explicit name: the engine auto-generates the physical name.
              return yield* Docker.Image("tiny-image", {
                tag: "latest",
                build: { context: root },
              });
            }),
          );
          imageRef = image.imageRef;
          expect(image.imageRef.endsWith(":latest")).toBe(true);
          expect(image.imageId?.length).toBeGreaterThan(0);
          expect(image.contextHash?.length).toBeGreaterThan(0);
        } finally {
          yield* stack.destroy().pipe(Effect.ignore);
          if (imageRef) {
            yield* runDockerCommand(["rmi", "-f", imageRef]).pipe(
              Effect.ignore,
            );
          }
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
        const hostPort = yield* freeHostPort;
        let containerName: string | undefined;
        try {
          const container = yield* stack.deploy(
            Effect.gen(function* () {
              // No explicit name: rely on the engine-generated physical name.
              return yield* Docker.Container("nginx-container", {
                image: "nginx:alpine",
                ports: [{ external: hostPort, internal: 80 }],
                start: true,
              });
            }),
          );
          containerName = container.name;
          expect(container.name.length).toBeGreaterThan(0);
          expect(container.state).toBe("running");
          const runtime = yield* Docker.inspectContainer(container.name);
          expect(runtime.ports["80/tcp"]).toBe(hostPort);
        } finally {
          yield* stack.destroy().pipe(Effect.ignore);
          if (containerName) {
            yield* runDockerCommand(["rm", "-f", containerName]).pipe(
              Effect.ignore,
            );
          }
        }
      }),
    { timeout: 120000 },
  );

  test.provider.skipIf(!dockerDaemonOk)(
    "container network aliases update without replacing the container",
    (stack) =>
      Effect.gen(function* () {
        let containerName: string | undefined;
        let networkName: string | undefined;
        try {
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
          containerName = first.container.name;
          networkName = first.network.name;
          const second = yield* deployWithAlias("new-alias");
          expect(second.container.id).toBe(first.container.id);

          const info = yield* inspectContainerInfo(second.container.name);
          const aliases =
            info?.NetworkSettings.Networks?.[second.network.name]?.Aliases ??
            [];
          expect(aliases).toContain("new-alias");
          expect(aliases).not.toContain("old-alias");
        } finally {
          yield* stack.destroy().pipe(Effect.ignore);
          if (containerName) {
            yield* runDockerCommand(["rm", "-f", containerName]).pipe(
              Effect.ignore,
            );
          }
          if (networkName) {
            yield* runDockerCommand(["network", "rm", networkName]).pipe(
              Effect.ignore,
            );
          }
        }
      }),
    { timeout: 120000 },
  );
});
