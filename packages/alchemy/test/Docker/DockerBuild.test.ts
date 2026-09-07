import { Docker, DockerLive } from "@/Docker/Docker.ts";
import { noopSession } from "@/Report.ts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const credentials = {
  server: "registry.example.test",
  username: "publisher",
  password: Redacted.make("REGISTRY_SECRET_SENTINEL"),
};
const build = {
  context: "/project/context",
  tag: "registry.example.test/app:latest",
  platform: "linux/amd64",
  file: "/project/Dockerfile",
  engineContext: "remote-builder",
};

const harness = (options?: { auth?: string; version?: string }) => {
  const commands: ChildProcess.StandardCommand[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag !== "StandardCommand") {
        throw new Error("Unexpected command pipeline");
      }
      commands.push(command);
      const output = command.args.includes("version")
        ? (options?.version ?? "github.com/docker/buildx v0.26.0 abc123")
        : "exported image\n";
      const stdout = Stream.succeed(new TextEncoder().encode(output));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const layer = DockerLive.pipe(
    Layer.provide(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          DOCKER_BIN: "docker-test",
          ...(options?.auth === undefined
            ? {}
            : { DOCKER_AUTH_CONFIG: options.auth }),
        }),
      ),
    ),
  );
  return { commands, layer };
};

describe("Docker registry builds", () => {
  it.effect(
    "exports with BuildKit and preserves source-registry auth and Docker context",
    () => {
      const { commands, layer } = harness({
        auth: JSON.stringify({
          auths: {
            "source.example.test": { auth: "c291cmNlOnRva2Vu" },
            "registry.example.test": { auth: "b2xkOnRva2Vu" },
          },
        }),
      });
      const notes: string[] = [];

      return Effect.gen(function* () {
        const docker = yield* Docker;
        yield* docker.image.build(
          build,
          {
            ...noopSession,
            note: (note) => Effect.sync(() => void notes.push(note)),
          },
          credentials,
        );

        const command = commands.find((entry) => entry.args.includes("--push"));
        expect(command).toBeDefined();
        expect(command?.command).toBe("docker-test");
        expect(command?.args).toEqual([
          "--context",
          "remote-builder",
          "buildx",
          "build",
          "--push",
          "/project/context",
          "--tag",
          "registry.example.test/app:latest",
          "--platform",
          "linux/amd64",
          "--file",
          "/project/Dockerfile",
        ]);
        expect(command?.options.extendEnv).toBe(true);
        expect(Object.keys(command?.options.env ?? {})).toEqual([
          "DOCKER_AUTH_CONFIG",
        ]);
        const auth = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Unknown),
        )(command?.options.env?.DOCKER_AUTH_CONFIG);
        expect(auth).toEqual({
          auths: {
            "source.example.test": { auth: "c291cmNlOnRva2Vu" },
            "registry.example.test": {
              auth: "cHVibGlzaGVyOlJFR0lTVFJZX1NFQ1JFVF9TRU5USU5FTA==",
            },
          },
        });
        expect(commands.flatMap((entry) => entry.args).join(" ")).not.toContain(
          "REGISTRY_SECRET_SENTINEL",
        );
        expect(notes).toContain("exported image");
        expect(commands.some((entry) => entry.args.includes("login"))).toBe(
          false,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps ordinary builds local without requiring Buildx", () => {
    const { commands, layer } = harness({ version: "old buildx" });
    return Effect.gen(function* () {
      const docker = yield* Docker;
      yield* docker.image.build(build);

      expect(commands).toHaveLength(1);
      expect(commands[0]?.args.slice(0, 4)).toEqual([
        "--context",
        "remote-builder",
        "image",
        "build",
      ]);
      expect(commands[0]?.options.env).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "rejects malformed auth configuration without exposing credentials",
    () => {
      const { commands, layer } = harness({
        auth: '{"auths":{"source.example.test":{"auth":"AUTH_SECRET_SENTINEL"}},',
      });
      return Effect.gen(function* () {
        const docker = yield* Docker;
        const error = yield* docker.image
          .build(build, undefined, credentials)
          .pipe(Effect.flip);

        expect(error.reason._tag).toBe("InvalidData");
        expect(error.reason.description).toContain("DOCKER_AUTH_CONFIG");
        expect(String(error)).not.toContain("AUTH_SECRET_SENTINEL");
        expect(JSON.stringify(error)).not.toContain("AUTH_SECRET_SENTINEL");
        expect(commands).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("rejects malformed base64 auth before launching Docker", () => {
    const auth = "AUTH_SECRET_SENTINEL!";
    const { commands, layer } = harness({
      auth: JSON.stringify({ auths: { "source.example.test": { auth } } }),
    });
    return Effect.gen(function* () {
      const docker = yield* Docker;
      const error = yield* docker.image
        .build(build, undefined, credentials)
        .pipe(Effect.flip);

      expect(error.reason._tag).toBe("InvalidData");
      expect(error.reason.description).toContain("DOCKER_AUTH_CONFIG");
      expect(String(error)).not.toContain(auth);
      expect(JSON.stringify(error)).not.toContain(auth);
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "rejects decoded auth without a username/password separator",
    () => {
      const auth = "QVVUSF9TRUNSRVRfU0VOVElORUw=";
      const { commands, layer } = harness({
        auth: JSON.stringify({ auths: { "source.example.test": { auth } } }),
      });
      return Effect.gen(function* () {
        const docker = yield* Docker;
        const error = yield* docker.image
          .build(build, undefined, credentials)
          .pipe(Effect.flip);

        expect(error.reason._tag).toBe("InvalidData");
        expect(error.reason.description).toContain("DOCKER_AUTH_CONFIG");
        expect(String(error)).not.toContain(auth);
        expect(JSON.stringify(error)).not.toContain(auth);
        expect(JSON.stringify(error)).not.toContain("AUTH_SECRET_SENTINEL");
        expect(commands).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "rejects Buildx versions that ignore registry environment credentials",
    () => {
      const { commands, layer } = harness({
        version: "github.com/docker/buildx v0.25.0 abc123",
      });
      return Effect.gen(function* () {
        const docker = yield* Docker;
        const error = yield* docker.image
          .build(build, undefined, credentials)
          .pipe(Effect.flip);

        expect(error.reason.description).toContain("Buildx 0.26.0 or newer");
        expect(error.reason.description).toContain("upgrade");
        expect(commands).toHaveLength(1);
        expect(commands[0]?.args).toEqual(["buildx", "version"]);
        expect(commands[0]?.options.env).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain("REGISTRY_SECRET_SENTINEL");
      }).pipe(Effect.provide(layer));
    },
  );
});
