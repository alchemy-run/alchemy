import * as Docker from "@alchemy.run/docker";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });
const tags = ["provider:docker", "provider:docker:container", "local"];

interface InspectedMount {
  Type: string;
  Name?: string;
  Source: string;
  Destination: string;
  RW: boolean;
}

const inspectMounts = (docker: Docker.Docker["Service"], container: string) =>
  docker
    .run(["container", "inspect", "--format", "{{json .Mounts}}", container])
    .pipe(Effect.map(({ stdout }) => JSON.parse(stdout) as InspectedMount[]));

/** Match the typed provider failure rather than rendered Cause text. */
const findInvalidMountOptions = (cause: Cause.Cause<unknown>) =>
  cause.reasons
    .filter(Cause.isFailReason)
    .map((reason) => reason.error)
    .find(
      (error): error is Docker.InvalidContainerOptions =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error._tag === "InvalidContainerOptions",
    );

test.provider(
  "mounts a managed named volume and preserves its data when only the container changes",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const program = (readOnly: boolean) =>
        Effect.gen(function* () {
          const volume = yield* Docker.Volume("mount-persistent-data");
          const container = yield* Docker.Container("mount-persistent-container", {
            image: "alpine:3.22",
            mounts: [{ type: "volume", source: volume.name, target: "/data", readOnly }],
            start: false,
          });
          return { volume, container };
        });

      const first = yield* stack.deploy(program(false));
      const oldMounts = yield* inspectMounts(docker, first.container.name);
      expect(oldMounts).toEqual([
        expect.objectContaining({
          Type: "volume",
          Name: first.volume.name,
          Destination: "/data",
          RW: true,
        }),
      ]);
      yield* docker.run([
        "run",
        "--rm",
        "-v",
        `${first.volume.name}:/data`,
        "alpine:3.22",
        "sh",
        "-c",
        "echo persisted > /data/marker",
      ]);

      expect(
        (yield* stack.plan(program(false))).resources["mount-persistent-container"]?.action,
      ).toBe("noop");
      const second = yield* stack.deploy(program(true));
      expect(second.container.id).not.toBe(first.container.id);
      expect(second.volume.name).toBe(first.volume.name);
      expect((yield* inspectMounts(docker, second.container.name))[0]?.RW).toBe(false);
      yield* docker.run([
        "run",
        "--rm",
        "-v",
        `${first.volume.name}:/data:ro`,
        "alpine:3.22",
        "test",
        "-f",
        "/data/marker",
      ]);
    }),
  { tags },
);

test.provider(
  "replaces a container when its mount source changes without deleting either volume",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const program = (which: "first" | "second" | "none") =>
        Effect.gen(function* () {
          const first = yield* Docker.Volume("mount-source-first");
          const second = yield* Docker.Volume("mount-source-second");
          const container = yield* Docker.Container("mount-source-container", {
            image: "alpine:3.22",
            mounts:
              which === "none"
                ? []
                : [
                    {
                      type: "volume" as const,
                      source: which === "first" ? first.name : second.name,
                      target: "/data",
                    },
                  ],
          });
          return { first, second, container };
        });

      const original = yield* stack.deploy(program("first"));
      yield* docker.run([
        "run",
        "--rm",
        "-v",
        `${original.first.name}:/data`,
        "alpine:3.22",
        "sh",
        "-c",
        "echo preserved > /data/marker",
      ]);
      const changed = yield* stack.deploy(program("second"));
      expect(changed.container.id).not.toBe(original.container.id);
      expect((yield* inspectMounts(docker, changed.container.name))[0]?.Name).toBe(
        changed.second.name,
      );
      const detached = yield* stack.deploy(program("none"));
      expect(detached.container.id).not.toBe(changed.container.id);
      expect(yield* inspectMounts(docker, detached.container.name)).toEqual([]);
      expect((yield* stack.plan(program("none"))).resources["mount-source-container"]?.action).toBe(
        "noop",
      );
      yield* docker.volume.inspect(original.first.name);
      yield* docker.volume.inspect(original.second.name);
      yield* docker.run([
        "run",
        "--rm",
        "-v",
        `${original.first.name}:/data:ro`,
        "alpine:3.22",
        "test",
        "-f",
        "/data/marker",
      ]);
    }),
  { tags },
);

test.provider(
  "supports typed mounts alongside legacy volumes and tmpfs in one container",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-mount-mixed-" });
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const program = Effect.gen(function* () {
        const data = yield* Docker.Volume("mixed-data");
        const container = yield* Docker.Container("mixed-container", {
          image: "alpine:3.22",
          volumes: [{ hostPath: data.name, containerPath: "/legacy" }],
          tmpfs: [{ path: "/legacy-tmp", size: "8m" }],
          mounts: [
            { type: "volume", source: data.name, target: "/data", readOnly: true },
            { type: "bind", source, target: "/config", readOnly: true },
            { type: "tmpfs", target: "/memory", size: "16m" },
          ],
        });
        return { data, container };
      });
      const { data, container } = yield* stack.deploy(program);
      expect(yield* inspectMounts(docker, container.name)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Type: "volume", Name: data.name, Destination: "/legacy" }),
          expect.objectContaining({
            Type: "volume",
            Name: data.name,
            Destination: "/data",
            RW: false,
          }),
          expect.objectContaining({ Type: "bind", Source: source, Destination: "/config" }),
          expect.objectContaining({ Type: "tmpfs", Destination: "/memory" }),
        ]),
      );
      // Legacy --tmpfs is represented in HostConfig.Tmpfs on a stopped
      // container; Docker need not include it in .Mounts until it starts.
      const { stdout } = yield* docker.run([
        "container",
        "inspect",
        "--format",
        "{{json .HostConfig.Tmpfs}}",
        container.name,
      ]);
      const tmpfs = JSON.parse(stdout) as Record<string, string>;
      expect(tmpfs["/legacy-tmp"]).toContain("size=8m");
      expect((yield* stack.plan(program)).resources["mixed-container"]?.action).toBe("noop");
    }),
  { tags },
);

test.provider(
  "preserves a stopped auto-named container when a mount replacement fails",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const original = yield* stack.deploy(
        Docker.Container("mount-safe-replacement", {
          image: "alpine:3.22",
          mounts: [{ type: "tmpfs", target: "/cache" }],
        }),
      );
      const invalid = Docker.Container("mount-safe-replacement", {
        image: "alpine:3.22",
        mounts: [
          {
            type: "bind",
            source: `/var/empty/alchemy-mount-absent-${stack.stage}`,
            target: "/cache",
          },
        ],
      });
      const plan = yield* stack.plan(invalid);
      const replacement = plan.resources["mount-safe-replacement"];
      expect(replacement?.action).toBe("replace");
      if (replacement?.action === "replace") {
        expect(replacement.deleteFirst).toBe(false);
      }
      const failed = yield* Effect.exit(stack.deploy(invalid));
      expect(Exit.isFailure(failed)).toBe(true);
      expect((yield* docker.container.inspect(original.name)).Id).toBe(original.id);

      // A successful retry should converge and garbage-collect the previous
      // generation without ever running two processes against shared data.
      const fixed = yield* stack.deploy(
        Docker.Container("mount-safe-replacement", {
          image: "alpine:3.22",
          mounts: [{ type: "tmpfs", target: "/cache", size: "16m" }],
        }),
      );
      expect(fixed.id).not.toBe(original.id);
      expect(fixed.name).not.toBe(original.name);
      const old = yield* Effect.exit(docker.container.inspect(original.id));
      expect(Exit.isFailure(old)).toBe(true);
    }),
  { tags },
);

test.provider(
  "keeps delete-first replacements for fixed names and running containers",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const program = (size: string) =>
        Effect.gen(function* () {
          const fixed = yield* Docker.Container("mount-fixed-name", {
            name: `alchemy-mount-fixed-${stack.name}-${stack.stage}`.replace(
              /[^a-zA-Z0-9_.-]/g,
              "-",
            ),
            image: "alpine:3.22",
            mounts: [{ type: "tmpfs", target: "/cache", size }],
          });
          const running = yield* Docker.Container("mount-running", {
            image: "alpine:3.22",
            command: ["sh", "-c", "sleep 300"],
            mounts: [{ type: "tmpfs", target: "/cache", size }],
            start: true,
          });
          const restarting = yield* Docker.Container("mount-restarting", {
            image: "alpine:3.22",
            restart: "always",
            mounts: [{ type: "tmpfs", target: "/cache", size }],
          });
          return { fixed, running, restarting };
        });
      const current = yield* stack.deploy(program("8m"));
      expect((yield* docker.container.inspect(current.running.name)).State.Status).toBe("running");
      const plan = yield* stack.plan(program("16m"));
      for (const fqn of ["mount-fixed-name", "mount-running", "mount-restarting"]) {
        const change = plan.resources[fqn];
        expect(change?.action).toBe("replace");
        if (change?.action === "replace") {
          expect(change.deleteFirst).toBe(true);
        }
      }
    }),
  { tags },
);

test.provider(
  "quotes CSV mount fields and mounts an existing bind path read-only",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-mount-bind-" });
      const source = path.join(dir, 'a,b "quoted" directory');
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(path.join(source, "marker"), "from-host");
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const container = yield* stack.deploy(
        Docker.Container("mount-quoted-bind", {
          image: "alpine:3.22",
          mounts: [{ type: "bind", source, target: "/input", readOnly: true }],
        }),
      );
      expect(yield* inspectMounts(docker, container.name)).toEqual([
        expect.objectContaining({ Type: "bind", Source: source, Destination: "/input", RW: false }),
      ]);
    }),
  { tags },
);

test.provider(
  "mounts an existing volume subdirectory and rejects a missing one",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const volume = yield* stack.deploy(Docker.Volume("mount-subpath-data"));
      yield* docker.run([
        "run",
        "--rm",
        "-v",
        `${volume.name}:/data`,
        "alpine:3.22",
        "sh",
        "-c",
        "mkdir -p /data/ready && echo marker > /data/ready/marker",
      ]);
      const program = Effect.gen(function* () {
        const data = yield* Docker.Volume("mount-subpath-data");
        return yield* Docker.Container("mount-subpath", {
          image: "alpine:3.22",
          mounts: [{ type: "volume", source: data.name, target: "/content", subpath: "ready" }],
        });
      });
      const container = yield* stack.deploy(program);
      // Docker inspect reports the volume root in .Mounts.Source even for
      // subpath mounts; the requested subpath lives in HostConfig.Mounts.
      const { stdout } = yield* docker.run([
        "container",
        "inspect",
        "--format",
        "{{json .HostConfig.Mounts}}",
        container.name,
      ]);
      const [configured] = JSON.parse(stdout) as Array<{ VolumeOptions?: { Subpath?: string } }>;
      expect(configured?.VolumeOptions?.Subpath).toBe("ready");
      yield* docker.run([
        "run",
        "--rm",
        "--mount",
        "type=volume,source=" + volume.name + ",target=/content,volume-subpath=ready",
        "alpine:3.22",
        "test",
        "-f",
        "/content/marker",
      ]);
      expect((yield* stack.plan(program)).resources["mount-subpath"]?.action).toBe("noop");
      // Docker may defer checking a volume-subpath until container start.
      // Keep the original container and volume declared during this deploy:
      // omitting them would ask Alchemy to remove them as obsolete resources.
      const withMissing = Effect.gen(function* () {
        const data = yield* Docker.Volume("mount-subpath-data");
        yield* Docker.Container("mount-subpath", {
          image: "alpine:3.22",
          mounts: [{ type: "volume", source: data.name, target: "/content", subpath: "ready" }],
        });
        return yield* Docker.Container("mount-missing-subpath", {
          image: "alpine:3.22",
          mounts: [{ type: "volume", source: data.name, target: "/data", subpath: "absent" }],
          start: true,
        });
      });
      const failure = yield* Effect.exit(stack.deploy(withMissing));
      expect(Exit.isFailure(failure)).toBe(true);
      expect((yield* docker.container.inspect(container.name)).Id).toBe(container.id);
    }),
  { tags },
);

test.provider(
  "does not copy image files into an empty volume when noCopy is true",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const program = Effect.gen(function* () {
        const data = yield* Docker.Volume("mount-no-copy-data");
        const container = yield* Docker.Container("mount-no-copy", {
          image: "alpine:3.22",
          mounts: [{ type: "volume", source: data.name, target: "/etc", noCopy: true }],
        });
        return { data, container };
      });
      const { data } = yield* stack.deploy(program);
      // Alpine's /etc contains passwd. Docker must not populate the volume
      // when volume-nocopy is requested at container creation.
      yield* docker.run([
        "run",
        "--rm",
        "-v",
        `${data.name}:/check:ro`,
        "alpine:3.22",
        "test",
        "!",
        "-e",
        "/check/passwd",
      ]);
    }),
  { tags },
);

test.provider(
  "creates a missing bind directory only when explicitly requested",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      const dirname = `alchemy-mount-create-${stack.name}-${stack.stage}`.replace(
        /[^a-zA-Z0-9_.-]/g,
        "-",
      );
      const source = `/tmp/${dirname}`;
      // The daemon and client can have different filesystems. Inspect through
      // Docker and remove only the temporary daemon-host path from this test.
      yield* Effect.addFinalizer(() =>
        docker
          .run(["run", "--rm", "-v", "/tmp:/host", "alpine:3.22", "rmdir", `/host/${dirname}`])
          .pipe(Effect.ignore),
      );
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const define = (createHostPath: boolean) =>
        Docker.Container("mount-bind-create", {
          image: "alpine:3.22",
          mounts: [{ type: "bind", source, target: "/data", createHostPath }],
        });

      const refused = yield* Effect.exit(stack.deploy(define(false)));
      expect(Exit.isFailure(refused)).toBe(true);
      const container = yield* stack.deploy(define(true));
      expect((yield* inspectMounts(docker, container.name))[0]?.Source).toBe(source);
    }),
  { tags },
);

test.provider(
  "passes Linux bind propagation and recursive mount options to Docker",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-mount-recursive-" });
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const container = yield* stack.deploy(
        Docker.Container("mount-recursive-bind", {
          image: "alpine:3.22",
          mounts: [
            {
              type: "bind",
              source,
              target: "/source",
              propagation: "rprivate",
              recursive: "disabled",
            },
          ],
        }),
      );
      const { stdout } = yield* docker.run([
        "container",
        "inspect",
        "--format",
        "{{json .HostConfig.Mounts}}",
        container.name,
      ]);
      const [mount] = JSON.parse(stdout) as Array<{
        BindOptions?: { Propagation: string; NonRecursive: boolean };
      }>;
      expect(mount?.BindOptions?.Propagation).toBe("rprivate");
      expect(mount?.BindOptions?.NonRecursive).toBe(true);
      expect((yield* inspectMounts(docker, container.name))[0]?.Source).toBe(source);
    }),
  { tags },
);

test.provider(
  "mounts tmpfs with positive size and octal POSIX mode",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const props: Docker.ContainerProps = {
        image: "alpine:3.22",
        mounts: [{ type: "tmpfs", target: "/run/data", size: "64m", mode: 0o1777 }],
      };
      const container = yield* stack.deploy(Docker.Container("mount-memory", props));
      expect(yield* inspectMounts(docker, container.name)).toEqual([
        expect.objectContaining({ Type: "tmpfs", Destination: "/run/data" }),
      ]);
      const { stdout } = yield* docker.run([
        "container",
        "inspect",
        "--format",
        "{{json .HostConfig.Mounts}}",
        container.name,
      ]);
      const [mount] = JSON.parse(stdout) as Array<{
        TmpfsOptions?: { SizeBytes: number; Mode: number };
      }>;
      expect(mount?.TmpfsOptions?.SizeBytes).toBe(64 * 1024 * 1024);
      expect(mount?.TmpfsOptions?.Mode).toBe(0o1777);
    }),
  { tags },
);

test.provider(
  "keeps the legacy container intact when mounts are omitted or empty",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const original = yield* stack.deploy(
        Docker.Container("mount-empty", { image: "alpine:3.22" }),
      );
      const unchanged = Docker.Container("mount-empty", { image: "alpine:3.22", mounts: [] });
      expect((yield* stack.plan(unchanged)).resources["mount-empty"]?.action).toBe("noop");
      expect((yield* stack.deploy(unchanged)).id).toBe(original.id);
    }),
  { tags },
);

test.provider(
  "rejects conflicting mount destinations before replacing a live container",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const first = yield* stack.deploy(
        Docker.Container("mount-conflict", { image: "alpine:3.22" }),
      );
      const props: Docker.ContainerProps = {
        image: "alpine:3.22",
        volumes: [{ hostPath: "named-data", containerPath: "/data" }],
        mounts: [{ type: "tmpfs", target: "/data/" }],
      };
      const invalid = Docker.Container("mount-conflict", props);
      const failure = yield* stack.plan(invalid).pipe(
        Effect.as(undefined),
        Effect.catchCause((cause) => Effect.succeed(findInvalidMountOptions(cause))),
      );
      expect(failure?._tag).toBe("InvalidContainerOptions");
      expect(failure?.path).toBe("mounts[0].target");
      expect((yield* docker.container.inspect(first.name)).Id).toBe(first.id);
    }),
  { tags },
);

test.provider(
  "decodes malformed mount declarations with field-specific typed errors before replacement",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const original = yield* stack.deploy(
        Docker.Container("mount-structural-errors", { image: "alpine:3.22" }),
      );
      // Simulate JS/state input bypassing the TypeScript interface. Schema
      // must reject it before Docker or delete-first reconciliation is called.
      const cases: Array<{ mounts: unknown; path: string }> = [
        { mounts: null, path: "mounts" },
        { mounts: {}, path: "mounts" },
        { mounts: [null], path: "mounts[0]" },
        {
          mounts: [{ type: "bind", source: "/tmp", target: "/data", readOnly: "yes" }],
          path: "mounts[0].readOnly",
        },
        {
          mounts: [{ type: "volume", source: "named", target: "/data", noCopy: 1 }],
          path: "mounts[0].noCopy",
        },
        {
          mounts: [{ type: "tmpfs", target: "/run", randomOption: true }],
          path: "mounts[0].randomOption",
        },
        {
          mounts: [{ type: "bind", source: "/tmp", target: "/data", propagation: "invalid" }],
          path: "mounts[0].propagation",
        },
        { mounts: [{ type: "image", source: "alpine", target: "/data" }], path: "mounts[0]" },
      ];
      for (const { mounts, path } of cases) {
        const props: Docker.ContainerProps = {
          image: "alpine:3.22",
          mounts: mounts as Docker.Container.Mount[],
        };
        const failure = yield* stack.plan(Docker.Container("mount-structural-errors", props)).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findInvalidMountOptions(cause))),
        );
        expect(failure?._tag).toBe("InvalidContainerOptions");
        expect(failure?.path).toBe(path);
        expect((yield* docker.container.inspect(original.name)).Id).toBe(original.id);
      }
    }),
  { tags },
);

test.provider(
  "refuses a mount replacement when its destination Docker context is unavailable",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const original = yield* stack.deploy(
        Docker.Container("mount-offline-context", { image: "alpine:3.22" }),
      );
      const invalid = Docker.Container("mount-offline-context", {
        image: "alpine:3.22",
        context: `no-such-docker-context-${stack.stage}`,
        mounts: [{ type: "tmpfs", target: "/run" }],
      });
      const failed = yield* Effect.exit(stack.plan(invalid));
      expect(Exit.isFailure(failed)).toBe(true);
      expect((yield* docker.container.inspect(original.name)).Id).toBe(original.id);
    }),
  { tags },
);

test.provider(
  "refuses to remove a mount when the replacement Docker context is unavailable",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const original = yield* stack.deploy(
        Docker.Container("mount-offline-removal", {
          image: "alpine:3.22",
          mounts: [{ type: "tmpfs", target: "/run" }],
        }),
      );
      const invalid = Docker.Container("mount-offline-removal", {
        image: "alpine:3.22",
        context: `missing-replacement-${stack.stage}`,
        mounts: [],
      });
      const failed = yield* Effect.exit(stack.plan(invalid));
      expect(Exit.isFailure(failed)).toBe(true);
      expect((yield* docker.container.inspect(original.name)).Id).toBe(original.id);
    }),
  { tags },
);

test.provider(
  "rejects Windows mount targets for a Linux daemon before deleting the old container",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const { stdout: os } = yield* docker.run(["info", "--format", "{{.OSType}}"]);
      if (os !== "linux") return;
      const original = yield* stack.deploy(
        Docker.Container("mount-wrong-daemon-path", { image: "alpine:3.22" }),
      );
      const invalid = Docker.Container("mount-wrong-daemon-path", {
        image: "alpine:3.22",
        mounts: [{ type: "tmpfs", target: "C:\\data" }],
      });
      const failure = yield* stack.plan(invalid).pipe(
        Effect.as(undefined),
        Effect.catchCause((cause) => Effect.succeed(findInvalidMountOptions(cause))),
      );
      expect(failure?.path).toBe("mounts[0].target");
      expect((yield* docker.container.inspect(original.name)).Id).toBe(original.id);
    }),
  { tags },
);

test.provider(
  "rejects invalid mount options without replacing a live container",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const original = yield* stack.deploy(
        Docker.Container("mount-invalid-options", { image: "alpine:3.22" }),
      );
      const errors: Array<{ mounts: Docker.Container.Mount[]; expected: string }> = [
        {
          mounts: [{ type: "bind", source: "relative/path", target: "/config" }],
          expected: "mounts[0].source",
        },
        {
          mounts: [{ type: "tmpfs", target: "/run", size: "-1m" }],
          expected: "mounts[0].size",
        },
        {
          mounts: [{ type: "tmpfs", target: "/" }],
          expected: "mounts[0].target",
        },
        {
          mounts: [{ type: "volume", source: "data", target: "/data", subpath: "../escape" }],
          expected: "mounts[0].subpath",
        },
        {
          mounts: [
            { type: "tmpfs", target: "/cache" },
            { type: "tmpfs", target: "/cache/" },
          ],
          expected: "mounts[1].target",
        },
        {
          mounts: [
            { type: "tmpfs", target: "/scratch/../data" },
            { type: "tmpfs", target: "/data" },
          ],
          expected: "mounts[1].target",
        },
      ];
      for (const { mounts, expected } of errors) {
        const props: Docker.ContainerProps = { image: "alpine:3.22", mounts };
        const failure = yield* stack.plan(Docker.Container("mount-invalid-options", props)).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findInvalidMountOptions(cause))),
        );
        expect(failure?._tag).toBe("InvalidContainerOptions");
        expect(failure?.path).toBe(expected);
        expect((yield* docker.container.inspect(original.name)).Id).toBe(original.id);
      }
    }),
  { tags },
);
