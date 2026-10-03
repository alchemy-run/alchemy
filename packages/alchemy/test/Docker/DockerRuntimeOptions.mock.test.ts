import {
  Container,
  ContainerProvider,
  Docker,
  DockerLive,
  type ContainerProps,
} from "@/Docker";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";

const makeDocker = (inspect?: unknown) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const args = command._tag === "StandardCommand" ? command.args : [];
    calls.push(args);
    const stdout = args.includes("inspect")
      ? JSON.stringify(inspect ?? [])
      : "container-id\n";
    return Effect.gen(function* () {
      const bytes = yield* Effect.sync(() => new TextEncoder().encode(stdout));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(bytes),
        stderr: Stream.empty,
        all: Stream.make(bytes),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    });
  });
  const layer = Layer.fresh(DockerLive).pipe(
    Layer.provide(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { calls, layer };
};

const runWithDocker = <A>(
  effect: Effect.Effect<A, unknown, Docker>,
  layer: Layer.Layer<Docker>,
) => effect.pipe(Effect.provide(layer));

const invalidRuntimeOptions = (options: Partial<ContainerProps>) =>
  Effect.gen(function* () {
    const fake = makeDocker();
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const provider = yield* Container.Provider;
        return yield* provider.diff!({
          id: "invalid-options",
          fqn: "invalid-options",
          instanceId: "instance",
          olds: { name: "invalid-options", image: "busybox" },
          news: { name: "invalid-options", image: "busybox", ...options },
          oldBindings: [],
          newBindings: [],
          output: undefined,
        });
      }).pipe(
        Effect.provide(ContainerProvider().pipe(Layer.provide(fake.layer))),
        Effect.provideService(Stack, {
          name: "docker-runtime-options",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
      ),
    );
    return { fake, result };
  });

describe("Docker.Container runtime options", () => {
  it.effect("omits runtime flags when new options are absent", () =>
    Effect.gen(function* () {
      const fake = makeDocker();
      yield* runWithDocker(
        Effect.gen(function* () {
          const docker = yield* Docker;
          yield* docker.container.create({
            name: "legacy",
            image: "busybox",
            volume: undefined,
            env: undefined,
            restart: "no",
            rm: false,
            "health-cmd": undefined,
            "health-interval": undefined,
            "health-timeout": undefined,
            "health-retries": undefined,
            "health-start-period": undefined,
            "health-start-interval": undefined,
            "stop-timeout": undefined,
            p: undefined,
            network: undefined,
            "cap-add": undefined,
            device: undefined,
            command: undefined,
          });
        }),
        fake.layer,
      );
      expect(fake.calls[0]).not.toContain("--network");
      expect(fake.calls[0]).not.toContain("--cap-add");
      expect(fake.calls[0]).not.toContain("--device");
    }),
  );

  it.effect("forwards namespace, capabilities, and devices to create", () =>
    Effect.gen(function* () {
      const fake = makeDocker();
      yield* runWithDocker(
        Effect.gen(function* () {
          const docker = yield* Docker;
          yield* docker.container.create({
            name: "sidecar",
            image: "busybox",
            volume: undefined,
            env: undefined,
            restart: "no",
            rm: false,
            "health-cmd": undefined,
            "health-interval": undefined,
            "health-timeout": undefined,
            "health-retries": undefined,
            "health-start-period": undefined,
            "health-start-interval": undefined,
            "stop-timeout": undefined,
            p: undefined,
            network: "container:donor-id",
            "cap-add": ["NET_ADMIN", "SYS_ADMIN"],
            device: ["/dev/fuse:/dev/fuse:rwm"],
            command: undefined,
          });
        }),
        fake.layer,
      );
      expect(fake.calls[0]).toEqual([
        "container",
        "create",
        "--name",
        "sidecar",
        "--restart",
        "no",
        "--network",
        "container:donor-id",
        "--cap-add",
        "NET_ADMIN",
        "--cap-add",
        "SYS_ADMIN",
        "--device",
        "/dev/fuse:/dev/fuse:rwm",
        "busybox",
      ]);
    }),
  );

  it.effect("forwards explicitly normalized runtime option arguments", () =>
    Effect.gen(function* () {
      const fake = makeDocker();
      yield* runWithDocker(
        Effect.gen(function* () {
          const docker = yield* Docker;
          yield* docker.container.create({
            name: "worker",
            image: "busybox",
            volume: undefined,
            env: undefined,
            restart: "no",
            rm: false,
            "health-cmd": undefined,
            "health-interval": undefined,
            "health-timeout": undefined,
            "health-retries": undefined,
            "health-start-period": undefined,
            "health-start-interval": undefined,
            "stop-timeout": undefined,
            p: undefined,
            network: "bridge",
            "cap-add": ["NET_ADMIN", "SYS_ADMIN"],
            device: ["/dev/a:/dev/a:r", "/dev/z:/dev/z:rwm"],
            command: undefined,
          });
        }),
        fake.layer,
      );
      expect(fake.calls[0]).toEqual([
        "container",
        "create",
        "--name",
        "worker",
        "--restart",
        "no",
        "--network",
        "bridge",
        "--cap-add",
        "NET_ADMIN",
        "--cap-add",
        "SYS_ADMIN",
        "--device",
        "/dev/a:/dev/a:r",
        "--device",
        "/dev/z:/dev/z:rwm",
        "busybox",
      ]);
    }),
  );

  it.effect("reads inspect defaults without requiring new fields", () =>
    Effect.gen(function* () {
      const fake = makeDocker([
        {
          Id: "id",
          Name: "/worker",
          State: { Status: "created" },
          Created: "2026-01-01T00:00:00Z",
          Config: { Image: "busybox", Labels: null },
          HostConfig: {
            PortBindings: null,
            Binds: null,
            ExtraHosts: null,
            RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            AutoRemove: false,
          },
          NetworkSettings: { Networks: null },
        },
      ]);
      const info = yield* runWithDocker(
        Effect.gen(function* () {
          const docker = yield* Docker;
          return yield* docker.container.inspect("worker");
        }),
        fake.layer,
      );
      expect(info.HostConfig.NetworkMode).toBeUndefined();
      expect(info.HostConfig.CapAdd).toBeUndefined();
      expect(info.HostConfig.Devices).toBeUndefined();
    }),
  );

  it.effect("reports conflicting namespace ports as a ConfigError", () =>
    Effect.gen(function* () {
      const { fake, result } = yield* invalidRuntimeOptions({
        networkMode: { container: "donor-id" },
        ports: [{ external: 8080, internal: 80 }],
      });
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ConfigError");
      }
      expect(fake.calls).toEqual([]);
    }),
  );

  it.effect("reports conflicting namespace networks as a ConfigError", () =>
    Effect.gen(function* () {
      const { fake, result } = yield* invalidRuntimeOptions({
        networkMode: "container:donor-id",
        networks: [{ name: "backend" }],
      });
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ConfigError");
      }
      expect(fake.calls).toEqual([]);
    }),
  );

  it.effect("reports conflicting device paths as a ConfigError", () =>
    Effect.gen(function* () {
      const { fake, result } = yield* invalidRuntimeOptions({
        devices: [
          { hostPath: "/dev/a", containerPath: "/dev/video" },
          { hostPath: "/dev/b", containerPath: "/dev/video" },
        ],
      });
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ConfigError");
      }
      expect(fake.calls).toEqual([]);
    }),
  );
});
