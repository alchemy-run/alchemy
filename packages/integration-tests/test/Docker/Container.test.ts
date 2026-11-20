import * as Docker from "@alchemy.run/docker";
import { healthcheckCommand, isHealthcheckDisabled } from "@alchemy.run/docker/HealthcheckCommand";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Action } from "alchemy/Action";
import { OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { inMemoryState, isResourceState, State, type ResourceState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { expectFound } from "./lookup.ts";
import { findAvailablePort } from "./Runtime.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState(), adopt: true });

test.provider(
  "configures kernel profiles, namespaces, supplementary groups, ulimits and process operations",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const { stdout: securityOptions } = yield* docker.run([
        "info",
        "--format",
        "{{json .SecurityOptions}}",
      ]);
      const appArmorProfile = securityOptions.includes("name=apparmor")
        ? "docker-default"
        : undefined;
      const name = "alchemy-test-container-advanced-runtime";
      const deploy = (maxFile: string) =>
        Docker.Container("advanced-runtime", {
          name,
          image: "alpine:3.22",
          seccompProfile: "builtin",
          appArmorProfile,
          userNamespace: "host",
          groupAdd: ["1234"],
          ulimits: { nofile: { soft: 1024, hard: 2048 } },
          logDriver: "json-file",
          logOptions: { "max-file": maxFile, "max-size": "1m" },
          oomScoreAdjustment: 200,
          stopSignal: "SIGINT",
          start: false,
        });

      const first = yield* stack.deploy(deploy("2"));
      yield* expectFound(Docker.Container.lookup({ name }), first);
      yield* Effect.addFinalizer(() => docker.container.remove(name, true).pipe(Effect.ignore));
      const info = yield* docker.container.inspect(name);
      expect(info.HostConfig.SecurityOpt).toContain("seccomp=builtin");
      if (appArmorProfile !== undefined) {
        expect(info.AppArmorProfile).toBe(appArmorProfile);
      }
      expect(info.HostConfig.UsernsMode).toBe("host");
      expect(info.HostConfig.GroupAdd).toContain("1234");
      expect(info.HostConfig.Ulimits).toEqual(
        expect.arrayContaining([{ Name: "nofile", Soft: 1024, Hard: 2048 }]),
      );
      expect(info.HostConfig.LogConfig).toMatchObject({
        Type: "json-file",
        Config: { "max-file": "2", "max-size": "1m" },
      });
      expect(info.HostConfig.OomScoreAdj).toBe(200);
      expect(info.Config.StopSignal).toBe("SIGINT");

      expect((yield* stack.plan(deploy("2"))).resources["advanced-runtime"]?.action).toBe("noop");
      expect((yield* stack.deploy(deploy("2"))).id).toBe(first.id);
      expect((yield* stack.plan(deploy("3"))).resources["advanced-runtime"]?.action).toBe(
        "replace",
      );
      const second = yield* stack.deploy(deploy("3"));
      expect(second.id).not.toBe(first.id);
      expect(
        (yield* docker.container.inspect(name)).HostConfig.LogConfig?.Config?.["max-file"],
      ).toBe("3");
      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "replaces a container when a custom seccomp profile file changes",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker.Docker;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-seccomp-profile-",
      });
      const profile = path.join(dir, "seccomp.json");
      const writeProfile = (blockedSyscall: string) =>
        fs.writeFileString(
          profile,
          JSON.stringify({
            defaultAction: "SCMP_ACT_ALLOW",
            syscalls: [{ names: [blockedSyscall], action: "SCMP_ACT_ERRNO" }],
          }),
        );
      yield* writeProfile("getppid");
      const name = "alchemy-test-container-file-seccomp";
      const deploy = () =>
        Docker.Container("file-seccomp", {
          name,
          image: "alpine:3.22",
          seccompProfile: profile,
          start: false,
        });
      const first = yield* stack.deploy(deploy());
      yield* Effect.addFinalizer(() => docker.container.remove(name, true).pipe(Effect.ignore));
      expect((yield* stack.plan(deploy())).resources["file-seccomp"]?.action).toBe("noop");
      expect((yield* stack.deploy(deploy())).id).toBe(first.id);
      yield* writeProfile("getuid");
      expect((yield* stack.plan(deploy())).resources["file-seccomp"]?.action).toBe("update");
      const second = yield* stack.deploy(deploy());
      expect(second.id).not.toBe(first.id);
      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "enforces container resource limits and security options across replacements",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const name = "alchemy-test-container-runtime-hardening";
      const deploy = (pidsLimit: number) =>
        Docker.Container("runtime-hardening", {
          name,
          image: "alpine:3.22",
          memory: "256m",
          memorySwap: "256m",
          memoryReservation: "128m",
          cpus: 0.5,
          pidsLimit,
          readOnlyRootFilesystem: true,
          capDrop: ["ALL"],
          noNewPrivileges: true,
          init: true,
          user: "1234:1234",
          tmpfs: [{ path: "/tmp", size: "32m", mode: 0o1777 }],
          start: false,
        });

      const first = yield* stack.deploy(deploy(128));
      yield* Effect.addFinalizer(() => docker.container.remove(name, true).pipe(Effect.ignore));
      const inspect = yield* docker.container.inspect(name);
      expect(inspect.HostConfig.Memory).toBe(268435456);
      expect(inspect.HostConfig.MemorySwap).toBe(268435456);
      expect(inspect.HostConfig.MemoryReservation).toBe(134217728);
      expect(inspect.HostConfig.NanoCpus).toBe(500000000);
      expect(inspect.HostConfig.PidsLimit).toBe(128);
      expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspect.HostConfig.CapDrop).toContain("ALL");
      expect(
        inspect.HostConfig.SecurityOpt?.some((opt) => opt.startsWith("no-new-privileges")),
      ).toBe(true);
      expect(inspect.HostConfig.Init).toBe(true);
      expect(inspect.Config.User).toBe("1234:1234");
      expect(inspect.HostConfig.Tmpfs?.["/tmp"]).toContain("size=32m");
      expect(inspect.HostConfig.Tmpfs?.["/tmp"]).toContain("mode=1777");

      const unchanged = yield* stack.plan(deploy(128));
      expect(unchanged.resources["runtime-hardening"]?.action).toBe("noop");
      expect((yield* stack.deploy(deploy(128))).id).toBe(first.id);

      const changed = yield* stack.plan(deploy(256));
      expect(changed.resources["runtime-hardening"]).toMatchObject({
        action: "replace",
        deleteFirst: true,
      });
      const second = yield* stack.deploy(deploy(256));
      expect(second.id).not.toBe(first.id);
      expect((yield* docker.container.inspect(name)).HostConfig.PidsLimit).toBe(256);

      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "enforces unprivileged read-only execution while keeping tmpfs writable",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const name = "alchemy-test-container-unprivileged-exec";
      const container = Docker.Container("unprivileged-exec", {
        name,
        image: "alpine:3.22",
        command: ["sleep", "120"],
        memory: "64m",
        memorySwap: "64m",
        readOnlyRootFilesystem: true,
        capDrop: ["ALL"],
        noNewPrivileges: true,
        init: true,
        user: "1234:1234",
        tmpfs: [{ path: "/tmp", mode: 0o1777 }],
        start: true,
      });
      const deployed = yield* stack.deploy(container);
      yield* Effect.addFinalizer(() => docker.container.remove(name, true).pipe(Effect.ignore));
      expect(deployed.status).toBe("running");

      const exec = (...command: string[]) => docker.run(["container", "exec", name, ...command]);
      expect((yield* exec("id", "-u")).stdout).toBe("1234");
      expect((yield* exec("grep", "NoNewPrivs", "/proc/self/status")).stdout).toMatch(
        /NoNewPrivs:\s+1/,
      );
      expect((yield* exec("touch", "/alchemy-write").pipe(Effect.flip))._tag).toBe("PlatformError");
      yield* exec("touch", "/tmp/alchemy-write");
      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "applies container creation options and replaces the container when they change",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const name = `alchemy-test-container-creation-options-${stack.stage}`;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));

      const deploy = (sharedMemorySize: string) =>
        Docker.Container("creation-options", {
          name,
          image: "alpine:3.22",
          platform: "linux/amd64",
          entrypoint: "/bin/sh",
          command: ["-c", "echo ready"],
          workingDirectory: "/workspace",
          ipcNamespace: "private",
          pidNamespace: "host",
          sysctls: { "net.ipv4.ip_unprivileged_port_start": "1024" },
          sharedMemorySize,
          gpuDevices: "all",
          privileged: true,
          keepStdinOpen: true,
          allocatePseudoTerminal: true,
          start: false, // GPU requests are inspected, not executed on hosts without GPUs.
        });

      const first = yield* stack.deploy(deploy("128m"));
      const inspect = yield* docker.container.inspect(name);
      expect(inspect.Config.Entrypoint).toEqual(["/bin/sh"]);
      expect(inspect.Config.Cmd).toEqual(["-c", "echo ready"]);
      expect(inspect.Config.WorkingDir).toBe("/workspace");
      expect(inspect.Config.Tty).toBe(true);
      expect(inspect.Config.OpenStdin).toBe(true);
      expect(inspect.HostConfig.IpcMode).toBe("private");
      expect(inspect.HostConfig.PidMode).toBe("host");
      expect(inspect.HostConfig.Sysctls).toMatchObject({
        "net.ipv4.ip_unprivileged_port_start": "1024",
      });
      expect(inspect.HostConfig.ShmSize).toBe(134217728);
      expect(inspect.HostConfig.Privileged).toBe(true);
      expect(inspect.HostConfig.DeviceRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Count: -1,
            Capabilities: [["gpu"]],
          }),
        ]),
      );

      expect((yield* stack.plan(deploy("128m"))).resources["creation-options"]?.action).toBe(
        "noop",
      );
      expect((yield* stack.deploy(deploy("128m"))).id).toBe(first.id);
      expect((yield* stack.plan(deploy("256m"))).resources["creation-options"]).toMatchObject({
        action: "replace",
        deleteFirst: true,
      });
      const second = yield* stack.deploy(deploy("256m"));
      expect(second.id).not.toBe(first.id);
      expect((yield* docker.container.inspect(name)).HostConfig.ShmSize).toBe(268435456);

      yield* stack.destroy();
      expect((yield* docker.container.inspect(name).pipe(Effect.flip))._tag).toBe("PlatformError");
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "runs a container with its custom entrypoint, working directory, shared memory, and sysctls",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const name = `alchemy-test-container-execution-options-${stack.stage}`;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));

      const instance = yield* stack.deploy(
        Docker.Container("execution-options", {
          name,
          image: "alpine:3.22",
          entrypoint: "/bin/sh",
          command: ["-c", "sleep 120"],
          workingDirectory: "/workspace",
          ipcNamespace: "private",
          sharedMemorySize: "128m",
          sysctls: { "net.ipv4.ip_unprivileged_port_start": "1024" },
          start: true,
        }),
      );
      expect(instance.status).toBe("running");
      const { stdout } = yield* docker.run([
        "container",
        "exec",
        name,
        "sh",
        "-c",
        "pwd; cat /proc/sys/net/ipv4/ip_unprivileged_port_start",
      ]);
      expect(stdout.trim().split("\n")).toEqual(["/workspace", "1024"]);
      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

const findTaggedError = <Tag extends string, A extends { readonly _tag: Tag }>(
  cause: Cause.Cause<unknown>,
  tag: Tag,
): A | undefined =>
  cause.reasons
    .filter(Cause.isFailReason)
    .map((reason) => reason.error)
    .find(
      (value): value is A =>
        typeof value === "object" && value !== null && "_tag" in value && value._tag === tag,
    );

const findInvalidContainerOptions = (cause: Cause.Cause<unknown>) =>
  findTaggedError<"InvalidContainerOptions", Docker.InvalidContainerOptions>(
    cause,
    "InvalidContainerOptions",
  );

const findContainerOwnershipConflict = (cause: Cause.Cause<unknown>) =>
  findTaggedError<"OwnedBySomeoneElse", OwnedBySomeoneElse>(cause, "OwnedBySomeoneElse");

test.provider(
  "rejects invalid create-time runtime changes without deleting the existing container",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const name = `alchemy-test-container-invalid-creation-update-${stack.stage}`;
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));

      const deploy = (options: Partial<Docker.ContainerProps> = {}) =>
        Docker.Container("invalid-creation-update", {
          image: "alpine:3.22",
          name,
          ...options,
        });
      const first = yield* stack.deploy(deploy({ sharedMemorySize: "128m" }));
      for (const { options, reason } of [
        { options: { sharedMemorySize: "garbage" }, reason: "sharedMemorySize" },
        { options: { sharedMemorySize: "0" }, reason: "sharedMemorySize" },
        { options: { sharedMemorySize: "-1m" }, reason: "sharedMemorySize" },
        { options: { sharedMemorySize: "1e999m" }, reason: "sharedMemorySize" },
        {
          options: {
            context: "alchemy-test-missing-docker-context",
            sharedMemorySize: "invalid",
          },
          reason: "sharedMemorySize",
        },
        { options: { workingDirectory: "relative" }, reason: "workingDirectory" },
        { options: { pidNamespace: "private" }, reason: "pidNamespace" },
        { options: { ipcNamespace: "invalid" }, reason: "ipcNamespace" },
        { options: { sharedMemorySize: "128m", ipcNamespace: "host" }, reason: "sharedMemorySize" },
        { options: { networkMode: "none", networks: [{ name: "bridge" }] }, reason: "networkMode" },
        { options: { networkMode: "host", networks: [{ name: "bridge" }] }, reason: "networkMode" },
        { options: { labels: { "alchemy::id": "another-owner" } }, reason: "labels" },
        {
          options: { networkMode: "container:donor", hostname: "sidecar" },
          reason: "networkMode.container",
        },
        {
          options: { networkMode: "container:donor", dns: ["1.1.1.1"] },
          reason: "networkMode.container",
        },
        {
          options: { networkMode: "container:donor", dnsSearch: ["internal.example"] },
          reason: "networkMode.container",
        },
        {
          options: { networkMode: "container:donor", dnsOptions: ["ndots:1"] },
          reason: "networkMode.container",
        },
        {
          options: { networkMode: "container:donor", extraHosts: ["api:192.0.2.1"] },
          reason: "networkMode.container",
        },
      ]) {
        const resource = deploy(options);
        const planned = yield* stack.plan(resource).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findInvalidContainerOptions(cause))),
        );
        expect(planned?._tag).toBe("InvalidContainerOptions");
        expect(planned?.message).toContain(reason);
        const deployed = yield* stack.deploy(resource).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findInvalidContainerOptions(cause))),
        );
        expect(deployed?._tag).toBe("InvalidContainerOptions");
        expect(deployed?.message).toContain(reason);
        expect((yield* docker.container.inspect(name)).Id).toBe(first.id);
      }
      yield* stack.destroy();
      expect((yield* docker.container.inspect(name).pipe(Effect.flip)).reason._tag).toBe(
        "NotFound",
      );
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "recreates an adopted container before claiming its hardening settings",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const name = "alchemy-test-container-runtime-hardening-adopt";
      yield* docker.container.remove(name, true).pipe(Effect.ignore);
      const { stdout: foreignId } = yield* docker.run([
        "container",
        "create",
        "--name",
        name,
        "alpine:3.22",
      ]);
      yield* Effect.addFinalizer(() => docker.container.remove(name, true).pipe(Effect.ignore));

      const adopted = yield* stack.deploy(
        Docker.Container("runtime-hardening-adopt", {
          name,
          image: "alpine:3.22",
          capDrop: ["ALL"],
          noNewPrivileges: true,
          start: false,
        }),
      );
      expect(adopted.id).not.toBe(foreignId.trim());
      const inspected = yield* docker.container.inspect(name);
      expect(inspected.HostConfig.CapDrop).toContain("ALL");
      expect(
        inspected.HostConfig.SecurityOpt?.some((opt) => opt.startsWith("no-new-privileges")),
      ).toBe(true);
      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "rejects invalid tmpfs targets before creating a Docker container",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const name = "alchemy-test-container-invalid-tmpfs";
      const failure = yield* stack
        .deploy(
          Docker.Container("invalid-tmpfs", {
            name,
            image: "alpine:3.22",
            tmpfs: [{ path: "tmp", size: "32m" }],
            start: false,
          }),
        )
        .pipe(Effect.flip);
      expect(String(failure)).toContain("tmpfs target must be an absolute path");
      const present = yield* docker.container.inspect(name).pipe(
        Effect.map(() => true),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      );
      expect(present).toBe(false);
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "rejects invalid or silently ignored container runtime restrictions",
  (stack) =>
    Effect.gen(function* () {
      const invalid = [
        {
          id: "swap-without-memory",
          props: { memorySwap: "128m" },
          reason: "memorySwap requires memory",
        },
        {
          id: "invalid-cpu-quota",
          props: { cpus: 0 },
          reason: "cpus must be a finite, positive number",
        },
        {
          id: "invalid-pids-limit",
          props: { pidsLimit: 0 },
          reason: "pidsLimit must be a positive integer",
        },
        {
          id: "empty-memory-limit",
          props: { memory: "" },
          reason: "memory cannot be empty",
        },
        {
          id: "empty-shared-memory",
          props: { sharedMemorySize: "" },
          reason: "sharedMemorySize cannot be empty",
        },
        {
          id: "empty-entrypoint",
          props: { entrypoint: " " },
          reason: "entrypoint cannot be empty",
        },
        {
          id: "empty-image-platform",
          props: { platform: "" },
          reason: "platform cannot be empty",
        },
        {
          id: "empty-gpu-request",
          props: { gpuDevices: " " },
          reason: "gpuDevices cannot be empty",
        },
        {
          id: "empty-pid-mode",
          props: { pidNamespace: " " },
          reason: "pidNamespace cannot be empty",
        },
        {
          id: "invalid-sysctl",
          props: { sysctls: { "net.ipv4.ip_unprivileged_port_start": "" } },
          reason: "sysctls contains an invalid setting",
        },
        {
          id: "empty-user",
          props: { user: " " },
          reason: "user cannot be empty",
        },
        {
          id: "empty-capability-drop",
          props: { capDrop: ["  "] },
          reason: "capDrop cannot contain empty capabilities",
        },
        {
          id: "empty-tmpfs-size",
          props: { tmpfs: [{ path: "/tmp", size: "" }] },
          reason: "tmpfs size cannot be empty",
        },
        {
          id: "empty-seccomp-profile",
          props: { seccompProfile: " " },
          reason: "seccompProfile cannot be empty",
        },
        {
          id: "empty-apparmor-profile",
          props: { appArmorProfile: "" },
          reason: "appArmorProfile cannot be empty",
        },
        {
          id: "invalid-supplementary-group",
          props: { groupAdd: [" "] },
          reason: "groupAdd cannot contain empty groups",
        },
        {
          id: "inverted-ulimit",
          props: { ulimits: { nofile: { soft: 2048, hard: 1024 } } },
          reason: "ulimits contains an invalid soft/hard limit",
        },
        {
          id: "invalid-log-option",
          props: { logOptions: { "max-file": "" } },
          reason: "logOptions contains an invalid option",
        },
        {
          id: "invalid-oom-score",
          props: { oomScoreAdjustment: 1001 },
          reason: "oomScoreAdjustment must be an integer",
        },
      ];
      for (const { id, props, reason } of invalid) {
        const error = yield* stack
          .deploy(
            Docker.Container(id, {
              image: "alpine:3.22",
              ...props,
              start: false,
            }),
          )
          .pipe(Effect.flip);
        expect(String(error)).toContain(reason);
      }
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "renders Docker healthcheck arrays as a --health-cmd string",
  () =>
    Effect.sync(() => {
      expect(healthcheckCommand("pg_isready -U postgres")).toBe("pg_isready -U postgres");
      expect(healthcheckCommand(["CMD-SHELL", "pg_isready -U postgres"])).toBe(
        "pg_isready -U postgres",
      );
      expect(healthcheckCommand(["CMD", "pg_isready", "-U", "postgres"])).toBe(
        "pg_isready -U postgres",
      );
      expect(healthcheckCommand(["CMD", "echo", "a b", "it's"])).toBe("echo 'a b' 'it'\\''s'");
      expect(healthcheckCommand(["NONE"])).toBeUndefined();
      // Arrays without a Docker marker keep the old behaviour: joined with
      // spaces and run in the shell.
      expect(healthcheckCommand(["curl -f localhost || exit 1"])).toBe(
        "curl -f localhost || exit 1",
      );
      expect(healthcheckCommand(["curl", "-f", "localhost", "||", "exit", "1"])).toBe(
        "curl -f localhost || exit 1",
      );
      expect(isHealthcheckDisabled(["NONE"])).toBe(true);
      expect(isHealthcheckDisabled(["CMD", "true"])).toBe(false);
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "replaces a container when its image, labels or stop timeout change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
      const resource = (props: Partial<Docker.ContainerProps> = {}) =>
        Docker.Container("replaced-on-change", { image: "nginx:alpine", ...props });
      yield* stack.deploy(
        resource({ labels: { "traefik.enable": "true" }, stopTimeout: "10 seconds" }),
      );
      for (const props of [
        {
          image: "nginx:1.27-alpine",
          labels: { "traefik.enable": "true" },
          stopTimeout: "10 seconds",
        },
        { labels: { "traefik.enable": "false" }, stopTimeout: "10 seconds" },
        { labels: { "traefik.enable": "true" }, stopTimeout: "30 seconds" },
      ] satisfies Partial<Docker.ContainerProps>[]) {
        expect((yield* stack.plan(resource(props))).resources["replaced-on-change"]).toMatchObject({
          action: "replace",
          deleteFirst: true,
        });
      }
      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

test.provider(
  "replaces a container when its Docker context changes",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const context = `alchemy-test-container-context-${stack.stage}`;
      const { stdout: host } = yield* docker.run([
        "context",
        "inspect",
        "--format",
        "{{.Endpoints.docker.Host}}",
      ]);
      yield* docker.context.remove(context, true).pipe(Effect.ignore);
      yield* docker.context.create({ name: context, docker: `host=${host.trim()}` });
      yield* Effect.addFinalizer(() => docker.context.remove(context, true).pipe(Effect.ignore));
      yield* stack.destroy();
      yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));

      const resource = (context?: string) =>
        Docker.Container("context-switch", { image: "nginx:alpine", context });
      const first = yield* stack.deploy(resource());
      expect((yield* stack.plan(resource(context))).resources["context-switch"]).toMatchObject({
        action: "replace",
        deleteFirst: true,
      });
      const second = yield* stack.deploy(resource(context));
      expect(second.id).not.toBe(first.id);
      yield* stack.destroy();
      expect((yield* docker.container.inspect(second.id).pipe(Effect.flip)).reason._tag).toBe(
        "NotFound",
      );
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

// The config-hash formula must not change for containers that don't use env
// files: a new hash would recreate every existing container on upgrade.
// Value recorded from the formula as first released (#1397).
test.provider(
  "keeps the config hash of containers without env files stable",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      yield* stack.destroy();
      const container = yield* stack.deploy(
        Docker.Container("golden-container", {
          name: "alchemy-test-golden-config-hash",
          image: "nginx:alpine",
          command: ["nginx", "-g", "daemon off;"],
          environment: { MODE: "golden" },
          labels: { "com.alchemy.test": "golden" },
          start: false,
        }),
      );
      const label = (yield* docker.container.inspect(container.name)).Config.Labels?.[
        "alchemy::container-config"
      ];
      expect(label).toBe("3c4c8eb58f436f13f0eb2cfe0a1edb45f0fab73d888ac381e163f986ce0e4e17");
      yield* stack.destroy();
    }),
  { tags: ["provider:docker", "provider:docker:container", "local"] },
);

describe(
  "Docker.Container",
  { tags: ["provider:docker", "provider:docker:container", "local"], concurrent: false },
  () => {
    test.provider("publishes and inspects bound host ports", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const hostPort = yield* findAvailablePort();
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
        // Docker always publishes the IPv4 (`0.0.0.0`) binding; whether it also
        // adds an IPv6 (`::`) binding depends on the daemon's IPv6 config, so
        // assert the guaranteed IPv4 mapping is present rather than requiring
        // both.
        expect(runtime?.NetworkSettings.Ports?.["80/tcp"]).toEqual(
          expect.arrayContaining([{ HostIp: "0.0.0.0", HostPort: `${hostPort}` }]),
        );
      }),
    );

    test.provider("creates a stopped container when start is false", (stack) =>
      Effect.gen(function* () {
        const container = yield* stack.deploy(
          Docker.Container("stopped-container", { image: "nginx:alpine", start: false }),
        );
        expect(container.status).toBe("created");
        expect(container.imageRef).toBe("nginx:alpine");
      }),
    );

    test.provider("applies container labels and a stop timeout", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const container = yield* stack.deploy(
          Docker.Container("traefik-container", {
            image: "nginx:alpine",
            labels: {
              "traefik.enable": "true",
              "traefik.http.services.web.loadbalancer.server.port": "80",
            },
            stopTimeout: "10 minutes",
            start: true,
          }),
        );

        const info = yield* docker.container.inspect(container.name);
        expect(info.Config.Labels).toEqual(
          expect.objectContaining({
            "traefik.enable": "true",
            "traefik.http.services.web.loadbalancer.server.port": "80",
          }),
        );
        expect(info.Config.StopTimeout).toBe(600);
      }),
    );

    test.provider(
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
          const aliases = info?.NetworkSettings.Networks?.[second.network.name]?.Aliases ?? [];
          expect(aliases).toContain("new-alias");
          expect(aliases).not.toContain("old-alias");
        }),
      { tags: ["provider:docker:network"] },
    );

    test.provider("attaches exclusively to its declared internal network", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = Effect.gen(function* () {
          const network = yield* Docker.Network("isolated-network", { internal: true });
          const container = yield* Docker.Container("isolated-container", {
            image: "alpine:3.22",
            command: ["sleep", "120"],
            networks: [{ name: network.name, aliases: ["app"] }],
            start: true,
          });
          return { network, container };
        });
        const first = yield* stack.deploy(resource);
        const inspect = yield* docker.container.inspect(first.container.id);
        expect(Object.keys(inspect.NetworkSettings.Networks ?? {})).toEqual([first.network.name]);
        const routes = yield* docker.run([
          "container",
          "exec",
          first.container.id,
          "cat",
          "/proc/net/route",
        ]);
        expect(routes.stdout).not.toMatch(/^\S+\s+00000000\s/m);
        expect((yield* stack.plan(resource)).resources["isolated-container"]?.action).toBe("noop");
        const second = yield* stack.deploy(resource);
        expect(second.container.id).toBe(first.container.id);
        yield* stack.destroy();
        expect(
          (yield* docker.container.inspect(first.container.id).pipe(Effect.flip)).reason._tag,
        ).toBe("NotFound");
      }),
    );

    test.provider(
      "removes the implicit default bridge when adopting an internal-only container",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const name = `alchemy-test-legacy-isolation-${stack.stage}`;
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const { stdout } = yield* docker.run([
            "container",
            "create",
            "--name",
            name,
            "alpine:3.22",
          ]);
          const originalId = stdout.trim();
          yield* Effect.addFinalizer(() =>
            docker.container.remove(originalId, true).pipe(Effect.ignore),
          );
          const resource = Effect.gen(function* () {
            const network = yield* Docker.Network("adopted-internal-network", { internal: true });
            const container = yield* Docker.Container("adopted-internal-container", {
              name,
              image: "alpine:3.22",
              networks: [{ name: network.name }],
            });
            return { container, network };
          });
          const first = yield* stack.deploy(resource);
          expect(first.container.id).toBe(originalId);
          const actual = yield* docker.container.inspect(originalId);
          expect(Object.keys(actual.NetworkSettings.Networks ?? {})).toEqual([first.network.name]);
          expect(
            (yield* stack.plan(resource)).resources["adopted-internal-container"]?.action,
          ).toBe("noop");
          yield* stack.destroy();
        }),
    );

    test.provider("attaches a container to a dual-stack Docker.Network with custom DNS", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = Effect.gen(function* () {
          const network = yield* Docker.Network("dual-stack-endpoint-network", {
            enableIPv6: true,
            ipam: {
              config: [
                { subnet: "10.57.48.0/24", gateway: "10.57.48.1" },
                { subnet: "fd57:48::/64", gateway: "fd57:48::1" },
              ],
            },
          });
          const secondary = yield* Docker.Network("secondary-endpoint-network", {
            ipam: { config: [{ subnet: "10.57.49.0/24" }] },
          });
          const container = yield* Docker.Container("dual-stack-endpoint-container", {
            image: "nginx:alpine",
            hostname: "api",
            dns: ["1.1.1.1"],
            dnsSearch: ["internal.example"],
            dnsOptions: ["ndots:1"],
            networks: [
              {
                name: network.name,
                aliases: ["api"],
                ipv4Address: "10.57.48.10",
                ipv6Address: "fd57:48::10",
                gatewayPriority: 1,
              },
              { name: secondary.name, gatewayPriority: -1 },
            ],
            start: true,
          });
          return { container, network, secondary };
        });
        const first = yield* stack.deploy(resource);
        const info = yield* docker.container.inspect(first.container.name);
        const endpoint = info.NetworkSettings.Networks?.[first.network.name];
        expect(info.Config.Hostname).toBe("api");
        expect(info.HostConfig.Dns).toEqual(["1.1.1.1"]);
        expect(info.HostConfig.DnsSearch).toEqual(["internal.example"]);
        expect(info.HostConfig.DnsOptions).toEqual(["ndots:1"]);
        expect(Object.keys(info.NetworkSettings.Networks ?? {}).sort()).toEqual(
          [first.network.name, first.secondary.name].sort(),
        );
        expect(endpoint?.IPAddress).toBe("10.57.48.10");
        expect(endpoint?.GlobalIPv6Address).toBe("fd57:48::10");
        expect(endpoint?.IPAMConfig).toMatchObject({
          IPv4Address: "10.57.48.10",
          IPv6Address: "fd57:48::10",
        });
        expect(endpoint?.GwPriority).toBe(1);
        expect(endpoint?.Aliases).toContain("api");
        expect(info.NetworkSettings.Networks?.[first.secondary.name]?.GwPriority).toBe(-1);
        const route = yield* docker.run([
          "exec",
          first.container.name,
          "ip",
          "route",
          "show",
          "default",
        ]);
        expect(route.stdout).toContain("10.57.48.1");
        expect(
          (yield* stack.plan(resource)).resources["dual-stack-endpoint-container"]?.action,
        ).toBe("noop");
        const second = yield* stack.deploy(resource);
        expect(second.container.id).toBe(first.container.id);
        yield* stack.destroy();
        const gone = yield* docker.container.inspect(first.container.id).pipe(Effect.flip);
        expect(gone.reason._tag).toBe("NotFound");
      }),
    );

    test.provider(
      "reconciles endpoint IP, alias and gateway priority without container replacement",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const resource = (
            ipv4Address: string | undefined,
            alias: string,
            gatewayPriority: number,
          ) =>
            Effect.gen(function* () {
              const network = yield* Docker.Network("reconfigured-endpoint-network", {
                ipam: { config: [{ subnet: "10.57.50.0/24" }] },
              });
              const container = yield* Docker.Container("reconfigured-endpoint-container", {
                image: "nginx:alpine",
                networks: [{ name: network.name, aliases: [alias], ipv4Address, gatewayPriority }],
                start: true,
              });
              return { container, network };
            });
          const first = yield* stack.deploy(resource("10.57.50.10", "old-api", 0));
          expect(
            (yield* stack.plan(resource("10.57.50.11", "new-api", 1))).resources[
              "reconfigured-endpoint-container"
            ]?.action,
          ).toBe("update");
          const second = yield* stack.deploy(resource("10.57.50.11", "new-api", 1));
          expect(second.container.id).toBe(first.container.id);
          const updated = (yield* docker.container.inspect(second.container.name)).NetworkSettings
            .Networks?.[second.network.name];
          expect(updated?.IPAddress).toBe("10.57.50.11");
          expect(updated?.Aliases).toContain("new-api");
          expect(updated?.Aliases).not.toContain("old-api");
          expect(updated?.GwPriority).toBe(1);
          expect(
            (yield* stack.plan(resource("10.57.50.11", "new-api", 1))).resources[
              "reconfigured-endpoint-container"
            ]?.action,
          ).toBe("noop");
          const third = yield* stack.deploy(resource(undefined, "new-api", 0));
          expect(third.container.id).toBe(first.container.id);
          const dynamic = (yield* docker.container.inspect(third.container.name)).NetworkSettings
            .Networks?.[third.network.name];
          expect(dynamic?.IPAMConfig?.IPv4Address).toBeFalsy();
          expect(dynamic?.GwPriority).toBe(0);
          // Lost managed endpoints should be reconciled even when inputs did not change.
          yield* docker.network.disconnect({
            network: third.network.name,
            container: third.container.id,
          });
          expect(
            (yield* stack.plan(resource(undefined, "new-api", 0))).resources[
              "reconfigured-endpoint-container"
            ]?.action,
          ).toBe("update");
          const recovered = yield* stack.deploy(resource(undefined, "new-api", 0));
          expect(recovered.container.id).toBe(first.container.id);
          expect(
            (yield* docker.container.inspect(recovered.container.name)).NetworkSettings.Networks?.[
              recovered.network.name
            ],
          ).toBeDefined();
          yield* stack.destroy();
          const gone = yield* docker.container.inspect(first.container.id).pipe(Effect.flip);
          expect(gone.reason._tag).toBe("NotFound");
        }),
    );

    test.provider(
      "applies endpoint driver options without changing the network resource",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const options = {
            "com.docker.network.endpoint.sysctls": "net.ipv4.conf.IFNAME.log_martians=1",
          };
          const resource = Effect.gen(function* () {
            const network = yield* Docker.Network("endpoint-options-network");
            const container = yield* Docker.Container("endpoint-options-container", {
              image: "nginx:alpine",
              networks: [{ name: network.name, driverOpts: options }],
            });
            return { container, network };
          });
          const first = yield* stack.deploy(resource);
          const info = yield* docker.container.inspect(first.container.id);
          expect(info.NetworkSettings.Networks?.[first.network.name]?.DriverOpts).toMatchObject(
            options,
          );
          expect(
            (yield* stack.plan(resource)).resources["endpoint-options-container"]?.action,
          ).toBe("noop");
          const second = yield* stack.deploy(resource);
          expect(second.container.id).toBe(first.container.id);
          yield* stack.destroy();
          const gone = yield* docker.container.inspect(first.container.id).pipe(Effect.flip);
          expect(gone.reason._tag).toBe("NotFound");
        }),
    );

    test.provider("recreates a container when its DNS settings change", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = (dnsOptions: string[]) =>
          Docker.Container("dns-container", {
            image: "nginx:alpine",
            hostname: "dns-api",
            dns: ["1.1.1.1"],
            dnsSearch: ["internal.example"],
            dnsOptions,
          });
        const first = yield* stack.deploy(resource(["ndots:1"]));
        expect((yield* stack.plan(resource(["ndots:1"]))).resources["dns-container"]?.action).toBe(
          "noop",
        );
        expect((yield* stack.plan(resource(["ndots:2"]))).resources["dns-container"]?.action).toBe(
          "replace",
        );
        const second = yield* stack.deploy(resource(["ndots:2"]));
        expect(second.id).not.toBe(first.id);
        yield* stack.destroy();
        const gone = yield* docker.container.inspect(second.id).pipe(Effect.flip);
        expect(gone.reason._tag).toBe("NotFound");
      }),
    );

    test.provider("recreates an adopted container that lacks requested DNS and hostname", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        const name = `alchemy-test-legacy-dns-container-${stack.stage}`;
        yield* docker.container.remove(name, true).pipe(Effect.ignore);
        yield* Effect.addFinalizer(() => docker.container.remove(name, true).pipe(Effect.ignore));
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const { stdout: foreignId } = yield* docker.run([
          "container",
          "create",
          "--name",
          name,
          "nginx:alpine",
        ]);
        const adopted = yield* stack.deploy(
          Docker.Container("legacy-dns-container", {
            name,
            image: "nginx:alpine",
            hostname: "custom-hostname",
            dns: ["1.1.1.1"],
            dnsSearch: ["svc.internal"],
            dnsOptions: ["ndots:1"],
          }),
        );
        expect(adopted.id).not.toBe(foreignId.trim());
        const current = yield* docker.container.inspect(adopted.name);
        expect(current.Config.Hostname).toBe("custom-hostname");
        expect(current.HostConfig.Dns).toEqual(["1.1.1.1"]);
        expect(current.HostConfig.DnsSearch).toEqual(["svc.internal"]);
        expect(current.HostConfig.DnsOptions).toEqual(["ndots:1"]);
        yield* stack.destroy();
        const gone = yield* docker.container.inspect(adopted.id).pipe(Effect.flip);
        expect(gone.reason._tag).toBe("NotFound");
      }),
    );

    test.provider("removes a newly created container if endpoint attachment fails", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = `alchemy-test-bad-network-endpoint-${stack.stage}`;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        yield* Effect.addFinalizer(() => docker.container.remove(name, true).pipe(Effect.ignore));
        const resource = Effect.gen(function* () {
          const network = yield* Docker.Network("failed-initial-endpoint-network", {
            ipam: { config: [{ subnet: "10.57.51.0/24" }] },
          });
          return yield* Docker.Container("failed-initial-endpoint-container", {
            name,
            image: "nginx:alpine",
            networks: [{ name: network.name, ipv4Address: "10.57.52.10" }],
          });
        });
        yield* stack.deploy(resource).pipe(Effect.flip);
        const gone = yield* docker.container.inspect(name).pipe(Effect.flip);
        expect(gone.reason._tag).toBe("NotFound");
        yield* stack.destroy();
      }),
    );

    test.provider("restores a previous endpoint after a rejected address change", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = (ipv4Address: string, alias: string) =>
          Effect.gen(function* () {
            const network = yield* Docker.Network("failed-endpoint-update-network", {
              ipam: { config: [{ subnet: "10.57.53.0/24" }] },
            });
            const container = yield* Docker.Container("failed-endpoint-update-container", {
              image: "nginx:alpine",
              networks: [{ name: network.name, ipv4Address, aliases: [alias] }],
              start: true,
            });
            return { container, network };
          });
        const first = yield* stack.deploy(resource("10.57.53.10", "before"));
        const initialInfo = yield* docker.container.inspect(first.container.id);
        expect(initialInfo.NetworkSettings.Networks?.[first.network.name]?.IPAddress).toBe(
          "10.57.53.10",
        );
        const rejected = yield* Effect.exit(stack.deploy(resource("10.57.54.10", "after")));
        expect(Exit.isFailure(rejected)).toBe(true);
        const info = yield* docker.container.inspect(first.container.id);
        expect(Object.keys(info.NetworkSettings.Networks ?? {})).toContain(first.network.name);
        const endpoint = info.NetworkSettings.Networks?.[first.network.name];
        expect(endpoint?.IPAddress).toBe("10.57.53.10");
        expect(endpoint?.IPAMConfig?.IPv4Address).toBe("10.57.53.10");
        expect(endpoint?.Aliases).toContain("before");
        expect(endpoint?.Aliases).not.toContain("after");
        yield* stack.destroy();
        const gone = yield* docker.container.inspect(first.container.id).pipe(Effect.flip);
        expect(gone.reason._tag).toBe("NotFound");
      }),
    );

    test.provider("reconciles attachments referenced by network ID", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = (attached: boolean) =>
          Effect.gen(function* () {
            const network = yield* Docker.Network("network-id-attachment-network");
            const container = yield* Docker.Container("network-id-attachment-container", {
              image: "nginx:alpine",
              networks: attached ? [{ name: network.id, aliases: ["by-id"] }] : [],
              start: true,
            });
            return { container, network };
          });
        const first = yield* stack.deploy(resource(true));
        const initial = yield* docker.container.inspect(first.container.id);
        expect(initial.NetworkSettings.Networks?.[first.network.name]?.Aliases).toContain("by-id");

        // Docker reports endpoints under their names, although callers can
        // reference those same networks by ID.
        yield* docker.network.disconnect({
          network: first.network.id,
          container: first.container.id,
        });
        expect(
          (yield* stack.plan(resource(true))).resources["network-id-attachment-container"]?.action,
        ).toBe("update");
        const repaired = yield* stack.deploy(resource(true));
        expect(repaired.container.id).toBe(first.container.id);
        expect(
          (yield* docker.container.inspect(repaired.container.id)).NetworkSettings.Networks?.[
            first.network.name
          ]?.Aliases,
        ).toContain("by-id");

        const detached = yield* stack.deploy(resource(false));
        expect(detached.container.id).toBe(first.container.id);
        expect(
          (yield* docker.container.inspect(detached.container.id)).NetworkSettings.Networks?.[
            first.network.name
          ],
        ).toBeUndefined();
        yield* stack.destroy();
        const gone = yield* docker.container.inspect(first.container.id).pipe(Effect.flip);
        expect(gone.reason._tag).toBe("NotFound");
      }),
    );

    test.provider("configures an endpoint already selected by explicit networkMode", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = Effect.gen(function* () {
          const network = yield* Docker.Network("explicit-mode-network");
          const container = yield* Docker.Container("explicit-mode-container", {
            image: "nginx:alpine",
            networkMode: network.name,
            networks: [{ name: network.name, aliases: ["app"] }],
          });
          return { container, network };
        });
        const first = yield* stack.deploy(resource);
        const inspected = yield* docker.container.inspect(first.container.id);
        expect(Object.keys(inspected.NetworkSettings.Networks ?? {})).toEqual([first.network.name]);
        expect(inspected.NetworkSettings.Networks?.[first.network.name]?.Aliases).toContain("app");
        expect((yield* stack.plan(resource)).resources["explicit-mode-container"]?.action).toBe(
          "noop",
        );
        yield* stack.destroy();
      }),
    );

    test.provider("keeps a managed endpoint when switching between network name and ID", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = (byId: boolean, aliases: string[]) =>
          Effect.gen(function* () {
            const network = yield* Docker.Network("network-reference-switch");
            const container = yield* Docker.Container("network-reference-container", {
              image: "nginx:alpine",
              networks: [{ name: byId ? network.id : network.name, aliases }],
              start: true,
            });
            return { container, network };
          });

        const first = yield* stack.deploy(resource(false, ["before"]));
        const second = yield* stack.deploy(resource(true, ["after"]));
        expect(second.container.id).toBe(first.container.id);
        const byId = (yield* docker.container.inspect(second.container.id)).NetworkSettings
          .Networks?.[second.network.name];
        expect(byId?.Aliases).toContain("after");
        expect(byId?.Aliases).not.toContain("before");

        const third = yield* stack.deploy(resource(false, []));
        expect(third.container.id).toBe(first.container.id);
        const byName = (yield* docker.container.inspect(third.container.id)).NetworkSettings
          .Networks?.[third.network.name];
        expect(byName).toBeDefined();
        expect(byName?.Aliases).not.toContain("after");
        expect(
          (yield* stack.plan(resource(false, []))).resources["network-reference-container"]?.action,
        ).toBe("noop");
        yield* stack.destroy();
      }),
    );

    test.provider(
      "rejects duplicate network name and ID before replacing an existing container",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          yield* stack.destroy();
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const resource = (duplicate: boolean) =>
            Effect.gen(function* () {
              const network = yield* Docker.Network("duplicate-endpoint-identity-network");
              const container = yield* Docker.Container("duplicate-endpoint-identity-container", {
                image: "nginx:alpine",
                hostname: duplicate ? "changed-hostname" : "original-hostname",
                networks: duplicate
                  ? [{ name: network.name }, { name: network.id }]
                  : [{ name: network.name }],
              });
              return { network, container };
            });

          const first = yield* stack.deploy(resource(false));
          const planned = yield* stack.plan(resource(true)).pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(findInvalidContainerOptions(cause))),
          );
          expect(planned?._tag).toBe("InvalidContainerOptions");
          expect(planned?.message).toContain("networks[1].name");
          expect(planned?.path).toBe("networks[1].name");
          const deployed = yield* stack.deploy(resource(true)).pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(findInvalidContainerOptions(cause))),
          );
          expect(deployed?._tag).toBe("InvalidContainerOptions");
          expect(deployed?.path).toBe("networks[1].name");
          expect((yield* docker.container.inspect(first.container.name)).Id).toBe(
            first.container.id,
          );
          yield* stack.destroy();
        }),
      { tags: ["provider:docker:network"] },
    );

    test.provider("replaces the container when published ports change", (stack) =>
      Effect.gen(function* () {
        const firstPort = yield* findAvailablePort();
        const secondPort = yield* findAvailablePort();
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

    // Rewrite the container's persisted row into the wedged shape an
    // interrupted deploy leaves behind: `creating`, no attributes, and the
    // Output-valued `image` prop lost in the round-trip (#736).
    const wedgeContainerRow = (stack: { readonly name: string; readonly stage: string }) =>
      Effect.gen(function* () {
        const state = yield* yield* State;
        const stage = stack.stage;
        const fqns = yield* state.list({ stack: stack.name, stage });
        const rows = yield* Effect.forEach(fqns, (fqn) =>
          state.get({ stack: stack.name, stage, fqn }).pipe(Effect.map((row) => ({ fqn, row }))),
        );
        const wedged = rows.find(
          (r): r is { fqn: string; row: ResourceState } =>
            isResourceState(r.row) && r.row.resourceType === "Docker.Container",
        );
        if (!wedged) {
          return yield* Effect.die(new Error("no Docker.Container state row found after deploy"));
        }
        yield* state.set({
          stack: stack.name,
          stage,
          fqn: wedged.fqn,
          value: {
            ...wedged.row,
            status: "creating",
            attr: undefined,
            props: { ...wedged.row.props, image: undefined },
          },
        });
      });

    test.provider(
      "read recovers a creating-state container whose image prop was lost (#736)",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const docker = yield* Docker.Docker;

          const deployContainer = () =>
            stack.deploy(
              // No explicit name: the engine-generated physical name is stable
              // across both deploys, so `read` can find the live container.
              Docker.Container("read-recovery-container", { image: "nginx:alpine", start: false }),
            );

          const created = yield* deployContainer();
          // Safety net: remove the container if the test dies mid-way.
          yield* Effect.addFinalizer(() =>
            docker.container.remove(created.name, true).pipe(Effect.ignore),
          );

          yield* wedgeContainerRow(stack);

          // Before the fix this crashed in `read` with
          // `TypeError: undefined is not an object (evaluating 'image.imageRef')`.
          const recovered = yield* deployContainer();
          // Same container id — read/reconcile converged on the existing
          // container instead of creating a duplicate.
          expect(recovered.id).toBe(created.id);
          expect(recovered.imageRef).toBe("nginx:alpine");

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "diff recreates a creating-state container that vanished after its image prop was lost (#736)",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const docker = yield* Docker.Docker;

          const deployContainer = () =>
            stack.deploy(
              Docker.Container("diff-recovery-container", { image: "nginx:alpine", start: false }),
            );

          const created = yield* deployContainer();
          // Safety net: remove the container if the test dies mid-way.
          yield* Effect.addFinalizer(() =>
            docker.container.remove(created.name, true).pipe(Effect.ignore),
          );

          yield* wedgeContainerRow(stack);
          // Remove the container out-of-band so recovery `read` misses and the
          // engine falls through to `diff` with the junk creating-row props.
          yield* docker.container.remove(created.name, true);

          // Before the fix this crashed in `diff` with
          // `TypeError: undefined is not an object (evaluating 'image.imageRef')`.
          const recovered = yield* deployContainer();
          expect(recovered.id).not.toBe(created.id);
          expect(recovered.imageRef).toBe("nginx:alpine");
          expect(recovered.status).toBe("created");

          yield* stack.destroy();
        }),
      { timeout: 240_000 },
    );

    test.provider("passes environment values into the container (#1117)", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        // Environment values ride the Docker CLI's process environment (the
        // create args carry name-only `--env KEY` flags to keep secrets off
        // the command line) — before the fix every entry resolved empty.
        const container = yield* stack.deploy(
          Docker.Container("env-container", {
            image: "nginx:alpine",
            environment: {
              PLAIN_VALUE: "plain-value",
              SECRET_VALUE: Redacted.make("secret-value"),
            },
            start: false,
          }),
        );

        const info = yield* docker.container.inspect(container.name);
        expect(info.Config.Env).toEqual(
          expect.arrayContaining(["PLAIN_VALUE=plain-value", "SECRET_VALUE=secret-value"]),
        );
      }),
    );

    const writeEnvFiles = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-env-files-" });
      const base = path.join(dir, "base.env");
      const override = path.join(dir, "override.env");
      yield* fs.writeFileString(base, "FROM_BASE=base\nLAYERED=base\nEXPLICIT=base\n");
      yield* fs.writeFileString(override, "LAYERED=override\nEXPLICIT=override\n");
      return { base, override };
    });

    // Docker keeps every duplicate in `Config.Env`; what matters is the value
    // the process sees, so the container prints its environment and exits.
    const printEnv = ["sh", "-c", 'echo "$FROM_BASE $LAYERED $EXPLICIT"'];
    const readPrintedEnv = (name: string) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        return yield* docker.run(["logs", name]).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.repeat({
            schedule: Schedule.spaced("250 millis"),
            until: (output) => output.length > 0,
            times: 40,
          }),
        );
      });

    test.provider("loads env files in order with explicit environment winning", (stack) =>
      Effect.gen(function* () {
        const { base, override } = yield* writeEnvFiles;
        const container = yield* stack.deploy(
          Docker.Container("env-file-container", {
            image: "nginx:alpine",
            command: printEnv,
            envFiles: [base, override],
            environment: { EXPLICIT: "explicit" },
            start: true,
          }),
        );

        expect(yield* readPrintedEnv(container.name)).toBe("base override explicit");
      }),
    );

    test.provider("replaces the container when env file order changes", (stack) =>
      Effect.gen(function* () {
        const { base, override } = yield* writeEnvFiles;
        const deploy = (envFiles: string[]) =>
          stack.deploy(
            Docker.Container("env-file-order-container", {
              image: "nginx:alpine",
              command: printEnv,
              envFiles,
              start: true,
            }),
          );

        const first = yield* deploy([base, override]);
        expect(yield* readPrintedEnv(first.name)).toBe("base override override");
        const second = yield* deploy([override, base]);

        expect(second.id).not.toBe(first.id);
        expect(yield* readPrintedEnv(second.name)).toBe("base base base");
      }),
    );

    test.provider("replaces the container when an env file's contents change", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const fs = yield* FileSystem.FileSystem;
        const { base } = yield* writeEnvFiles;
        const deploy = () =>
          stack.deploy(
            Docker.Container("env-file-content-container", {
              image: "nginx:alpine",
              command: printEnv,
              envFiles: [base],
              start: true,
            }),
          );

        const first = yield* deploy();
        expect(yield* readPrintedEnv(first.name)).toBe("base base base");
        // Unchanged contents: the digest is stable, so nothing rolls.
        expect((yield* deploy()).id).toBe(first.id);

        // Same path, new contents: the next deploy replaces the container.
        yield* fs.writeFileString(base, "FROM_BASE=base\nLAYERED=edited-secret-value\n");
        const edited = Docker.Container("env-file-content-container", {
          image: "nginx:alpine",
          command: printEnv,
          envFiles: [base],
          start: true,
        });
        const plan = yield* stack.plan(edited);
        expect(plan.resources["env-file-content-container"]?.action).toBe("update");
        const second = yield* stack.deploy(edited);
        expect(second.id).not.toBe(first.id);
        expect(yield* readPrintedEnv(second.name)).toBe("base edited-secret-value");

        // Only the container's own label carries the digest; Alchemy state
        // holds neither the values nor the digest.
        const label = (yield* docker.container.inspect(second.name)).Config.Labels?.[
          "alchemy::container-config"
        ];
        expect(label).toBeDefined();
        const state = yield* yield* State;
        const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
        const rows = yield* Effect.forEach(fqns, (fqn) =>
          state.get({ stack: stack.name, stage: stack.stage, fqn }),
        );
        const persisted = yield* Effect.sync(() => JSON.stringify(rows));
        expect(persisted).not.toContain("edited-secret-value");
        expect(persisted).not.toContain(label!);
      }),
    );

    test.provider(
      "replaces the container when a later env file changes, given as a relative path",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { base, override } = yield* writeEnvFiles;
          // Docker resolves relative paths against the CLI's working
          // directory; the digest must read the same file.
          const relativeOverride = path.relative(process.cwd(), override);
          expect(path.isAbsolute(relativeOverride)).toBe(false);
          const container = Docker.Container("env-file-relative-container", {
            image: "nginx:alpine",
            command: printEnv,
            envFiles: [base, relativeOverride],
            start: true,
          });

          const first = yield* stack.deploy(container);
          expect(yield* readPrintedEnv(first.name)).toBe("base override override");

          yield* fs.writeFileString(override, "LAYERED=second-edit\nEXPLICIT=override\n");
          const plan = yield* stack.plan(container);
          expect(plan.resources["env-file-relative-container"]?.action).toBe("update");
          const second = yield* stack.deploy(container);
          expect(second.id).not.toBe(first.id);
          expect(yield* readPrintedEnv(second.name)).toBe("base second-edit override");
        }),
    );

    test.provider("fails the plan with the path when an env file is missing", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { base } = yield* writeEnvFiles;
        const container = Docker.Container("env-file-missing-container", {
          image: "nginx:alpine",
          envFiles: [base],
          start: false,
        });
        yield* stack.deploy(container);

        yield* fs.remove(base);
        const error = yield* stack.plan(container).pipe(Effect.flip);
        const report = yield* Effect.sync(() => String(error) + JSON.stringify(error));
        expect(report).toContain(base);
        expect(report).toContain("NotFound");
      }),
    );

    // Prints a marker even when the variable is unset, so the log is never empty.
    const printLayered = ["sh", "-c", 'echo "[$LAYERED]"'];

    test.provider("fails the plan with the path when an env file is unreadable", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { base } = yield* writeEnvFiles;
        const container = Docker.Container("env-file-unreadable-container", {
          image: "nginx:alpine",
          envFiles: [base],
          start: false,
        });
        yield* stack.deploy(container);

        yield* Effect.acquireRelease(fs.chmod(base, 0o000), () =>
          fs.chmod(base, 0o644).pipe(Effect.ignore),
        );
        const error = yield* stack.plan(container).pipe(Effect.flip);
        const report = yield* Effect.sync(() => String(error) + JSON.stringify(error));
        expect(report).toContain(base);
        expect(report).toContain("PermissionDenied");
      }),
    );

    test.provider("replaces the container when env files are added and removed", (stack) =>
      Effect.gen(function* () {
        const { base } = yield* writeEnvFiles;
        const deploy = (envFiles: string[] | undefined) =>
          stack.deploy(
            Docker.Container("env-file-toggle-container", {
              image: "nginx:alpine",
              command: printLayered,
              envFiles,
              start: true,
            }),
          );

        const without = yield* deploy(undefined);
        expect(yield* readPrintedEnv(without.name)).toBe("[]");
        const added = yield* deploy([base]);
        expect(added.id).not.toBe(without.id);
        expect(yield* readPrintedEnv(added.name)).toBe("[base]");
        const removed = yield* deploy(undefined);
        expect(removed.id).not.toBe(added.id);
        expect(yield* readPrintedEnv(removed.name)).toBe("[]");
      }),
    );

    test.provider("keys on env file contents, not timestamps or formatting intent", (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { base } = yield* writeEnvFiles;
        const container = Docker.Container("env-file-bytes-container", {
          image: "nginx:alpine",
          command: printLayered,
          envFiles: [base],
          start: true,
        });
        const first = yield* stack.deploy(container);

        // Rewriting identical bytes (new mtime) is not a change.
        const original = yield* fs.readFileString(base);
        yield* Effect.sleep("1100 millis");
        yield* fs.writeFileString(base, original);
        const touched = yield* stack.plan(container);
        expect(touched.resources["env-file-bytes-container"]?.action).toBe("noop");
        expect((yield* stack.deploy(container)).id).toBe(first.id);

        // The digest covers raw bytes, so even a comment-only edit rolls the
        // container: Alchemy does not interpret Docker's env-file syntax.
        yield* fs.writeFileString(base, `${original}# reviewed\n`);
        const commented = yield* stack.plan(container);
        expect(commented.resources["env-file-bytes-container"]?.action).toBe("update");
      }),
    );

    test.provider("tracks env files on an adopted container", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const fs = yield* FileSystem.FileSystem;
        const { base } = yield* writeEnvFiles;
        const name = "alchemy-test-adopted-env-file-container";
        yield* docker.container.remove(name, true).pipe(Effect.ignore);
        yield* Effect.addFinalizer(() => docker.container.remove(name, true).pipe(Effect.ignore));
        // Created outside Alchemy: no config-hash label to compare against.
        const { stdout: foreignId } = yield* docker.run([
          "container",
          "create",
          "--name",
          name,
          "--env-file",
          base,
          "nginx:alpine",
          ...printLayered,
        ]);
        const container = Docker.Container("env-file-adopted-container", {
          name,
          image: "nginx:alpine",
          command: printLayered,
          envFiles: [base],
          start: true,
        });

        // Adoption recreates it once so the label exists from then on.
        const adopted = yield* stack.deploy(container);
        expect(adopted.id).not.toBe(foreignId.trim());
        const label = (yield* docker.container.inspect(name)).Config.Labels?.[
          "alchemy::container-config"
        ];
        expect(label).toBeDefined();

        yield* fs.writeFileString(base, "LAYERED=after-adoption\n");
        const plan = yield* stack.plan(container);
        expect(plan.resources["env-file-adopted-container"]?.action).toBe("update");
        const updated = yield* stack.deploy(container);
        expect(yield* readPrintedEnv(updated.name)).toBe("[after-adoption]");
      }),
    );

    test.provider("detects env file edits for a container in a named Docker context", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const fs = yield* FileSystem.FileSystem;
        const { base } = yield* writeEnvFiles;
        const context = "alchemy-test-env-file-context";
        const { stdout: host } = yield* docker.run([
          "context",
          "inspect",
          "--format",
          "{{.Endpoints.docker.Host}}",
        ]);
        yield* docker.context.remove(context, true).pipe(Effect.ignore);
        yield* docker.context.create({ name: context, docker: `host=${host.trim()}` });
        yield* Effect.addFinalizer(() => docker.context.remove(context, true).pipe(Effect.ignore));

        const container = Docker.Container("env-file-context-container", {
          image: "nginx:alpine",
          command: printLayered,
          envFiles: [base],
          context,
          start: true,
        });
        const first = yield* stack.deploy(container);
        yield* fs.writeFileString(base, "LAYERED=in-context\n");
        const plan = yield* stack.plan(container);
        expect(plan.resources["env-file-context-container"]?.action).toBe("update");
        const second = yield* stack.deploy(container);
        expect(second.id).not.toBe(first.id);
        yield* stack.destroy();
      }),
    );

    test.provider(
      "does not replace the container when env files go from empty to omitted",
      (stack) =>
        Effect.gen(function* () {
          const first = yield* stack.deploy(
            Docker.Container("env-file-empty-container", {
              image: "nginx:alpine",
              envFiles: [],
              start: false,
            }),
          );
          const omitted = Docker.Container("env-file-empty-container", {
            image: "nginx:alpine",
            start: false,
          });
          const plan = yield* stack.plan(omitted);
          expect(plan.resources["env-file-empty-container"]?.action).not.toBe("replace");
          const second = yield* stack.deploy(omitted);
          expect(second.id).toBe(first.id);
        }),
    );
    // Runtime options are checked inside the running container, not on the
    // `docker container create` arguments.
    const sleeper = { image: "alpine:3.19", command: ["sleep", "300"], start: true };
    const exec = (name: string, ...command: string[]) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        return (yield* docker.run(["exec", name, ...command])).stdout.trim();
      });

    test.provider("shares a donor container's network namespace", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const { donor, sidecar } = yield* stack.deploy(
          Effect.gen(function* () {
            const donor = yield* Docker.Container("namespace-donor", {
              image: "nginx:alpine",
              start: true,
            });
            const sidecar = yield* Docker.Container("namespace-sidecar", {
              ...sleeper,
              networkMode: { container: donor.id },
            });
            return { donor, sidecar };
          }),
        );

        const info = yield* docker.container.inspect(sidecar.name);
        expect(info.HostConfig.NetworkMode).toBe(`container:${donor.id}`);
        // The sidecar reaches the donor's nginx on its own loopback.
        const page = yield* exec(sidecar.name, "wget", "-qO-", "http://127.0.0.1").pipe(
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 20 }),
        );
        expect(page).toContain("nginx");
      }),
    );

    test.provider("adds capabilities and exposes host devices", (stack) =>
      Effect.gen(function* () {
        const deploy = (capAdd: string[]) =>
          stack.deploy(
            Docker.Container("runtime-options-container", {
              ...sleeper,
              capAdd,
              devices: [{ hostPath: "/dev/zero", containerPath: "/dev/alchemy-zero" }],
            }),
          );

        // `ip link add` needs NET_ADMIN, which Docker does not grant by default.
        const first = yield* deploy(["NET_ADMIN"]);
        yield* exec(first.name, "ip", "link", "add", "alchemy0", "type", "dummy");
        expect(yield* exec(first.name, "sh", "-c", "head -c 4 /dev/alchemy-zero | wc -c")).toBe(
          "4",
        );

        // Duplicates and order normalize away: same container.
        const same = yield* deploy([" NET_ADMIN", "NET_ADMIN"]);
        expect(same.id).toBe(first.id);

        // A different capability set replaces the container.
        const replaced = yield* deploy(["SYS_TIME"]);
        expect(replaced.id).not.toBe(first.id);
        const denied = yield* exec(
          replaced.name,
          "ip",
          "link",
          "add",
          "alchemy0",
          "type",
          "dummy",
        ).pipe(Effect.flip);
        expect(denied._tag).toBe("PlatformError");
      }),
    );

    const invalidOptions: Array<[string, Partial<Docker.ContainerProps>]> = [
      [
        "ports",
        {
          networkMode: { container: "alchemy-missing-donor" },
          ports: [{ external: 0, internal: 80 }],
        },
      ],
      [
        "networks",
        { networkMode: "container:alchemy-missing-donor", networks: [{ name: "bridge" }] },
      ],
      ["invalid network IPv4", { networks: [{ name: "bridge", ipv4Address: "not-an-ip" }] }],
      ["network IPv6 supplied as IPv4", { networks: [{ name: "bridge", ipv4Address: "::1" }] }],
      [
        "network IPv4 supplied as IPv6",
        { networks: [{ name: "bridge", ipv6Address: "127.0.0.1" }] },
      ],
      ["invalid gateway priority", { networks: [{ name: "bridge", gatewayPriority: 0.5 }] }],
      [
        "duplicate networks",
        { networks: [{ name: "bridge" }, { name: "bridge", aliases: ["second"] }] },
      ],
      [
        "invalid endpoint driver options",
        { networks: [{ name: "bridge", driverOpts: { "": "value" } }] },
      ],
      ["empty network alias", { networks: [{ name: "bridge", aliases: [""] }] }],
      ["invalid DNS server", { dns: ["not-an-ip"] }],
      ["empty DNS search", { dnsSearch: [""] }],
      ["empty DNS option", { dnsOptions: [""] }],
      ["empty hostname", { hostname: " " }],
      [
        "conflicting device targets",
        {
          devices: [
            { hostPath: "/dev/zero", containerPath: "/dev/alchemy" },
            { hostPath: "/dev/null", containerPath: "/dev/alchemy" },
          ],
        },
      ],
    ];
    for (const [name, props] of invalidOptions) {
      test.provider(`rejects ${name} that cannot be combined before calling Docker`, (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const error = yield* stack
            .deploy(Docker.Container("invalid-runtime-options", { ...sleeper, ...props }))
            .pipe(Effect.flip);
          const report = yield* Effect.sync(() => String(error) + JSON.stringify(error));
          expect(report).toContain("InvalidContainerOptions");
          const listed = yield* docker.run([
            "ps",
            "--all",
            "--filter",
            "name=invalid-runtime-options",
            "--format",
            "{{.Names}}",
          ]);
          expect(listed.stdout.trim()).toBe("");
        }),
      );
    }

    test.provider("applies a healthcheck with unit-suffixed durations", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        // `normalizeDuration` used to emit a bare nanosecond count (e.g.
        // `1000000000`), which `docker container create` rejects with "missing
        // unit in duration" — so this deploy would fail outright before the fix.
        const container = yield* stack.deploy(
          Docker.Container("healthcheck-container", {
            image: "nginx:alpine",
            healthcheck: {
              cmd: "true",
              interval: "1 second",
              timeout: "2 seconds",
              retries: 3,
              startPeriod: "1 second",
            },
            start: true,
          }),
        );
        expect(container.status).toBe("running");

        // Docker reports the configured durations back in nanoseconds — assert
        // they round-tripped rather than being dropped or truncated.
        const info = yield* docker.container.inspect(container.name);
        const health = info?.Config.Healthcheck;
        expect(health?.Interval).toBe(1_000_000_000);
        expect(health?.Timeout).toBe(2_000_000_000);
        expect(health?.Retries).toBe(3);
        expect(health?.StartPeriod).toBe(1_000_000_000);
      }),
    );
    // The array form used to be joined with spaces, so `["CMD-SHELL", "true"]`
    // ran a command literally named `CMD-SHELL` and the container never
    // became healthy.
    test.provider("runs a CMD-SHELL array healthcheck as the shell command", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const container = yield* stack.deploy(
          Docker.Container("healthcheck-cmd-shell", {
            image: "nginx:alpine",
            healthcheck: { cmd: ["CMD-SHELL", "true"], interval: "1 second", retries: 1 },
            start: true,
          }),
        );
        const info = yield* docker.container.inspect(container.name);
        expect(info?.Config.Healthcheck?.Test).toEqual(["CMD-SHELL", "true"]);
      }),
    );

    test.provider("runs a CMD array healthcheck with its arguments quoted", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const container = yield* stack.deploy(
          Docker.Container("healthcheck-cmd-exec", {
            image: "nginx:alpine",
            healthcheck: { cmd: ["CMD", "echo", "a b"], interval: "1 second", retries: 1 },
            start: true,
          }),
        );
        const info = yield* docker.container.inspect(container.name);
        expect(info?.Config.Healthcheck?.Test).toEqual(["CMD-SHELL", "echo 'a b'"]);
      }),
    );

    test.provider("keeps a plain string healthcheck unchanged", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const container = yield* stack.deploy(
          Docker.Container("healthcheck-cmd-string", {
            image: "nginx:alpine",
            healthcheck: { cmd: "true", interval: "1 second", retries: 1 },
            start: true,
          }),
        );
        const info = yield* docker.container.inspect(container.name);
        expect(info?.Config.Healthcheck?.Test).toEqual(["CMD-SHELL", "true"]);
      }),
    );

    test.provider("runs an array without a marker as a shell line, as before", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const container = yield* stack.deploy(
          Docker.Container("healthcheck-cmd-legacy", {
            image: "nginx:alpine",
            healthcheck: { cmd: ["true || exit 1"], interval: "1 second", retries: 1 },
            start: true,
          }),
        );
        const info = yield* docker.container.inspect(container.name);
        expect(info?.Config.Healthcheck?.Test).toEqual(["CMD-SHELL", "true || exit 1"]);
      }),
    );

    test.provider("disables the image healthcheck with NONE", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const container = yield* stack.deploy(
          Docker.Container("healthcheck-none", {
            image: "nginx:alpine",
            healthcheck: { cmd: ["NONE"] },
            start: true,
          }),
        );
        const info = yield* docker.container.inspect(container.name);
        expect(info?.Config.Healthcheck?.Test).toEqual(["NONE"]);
      }),
    );

    // Stored form is not enough: the check must actually run in the container.
    const healthStatus = (name: string, until: "healthy" | "unhealthy") =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        return yield* docker.container.inspect(name).pipe(
          Effect.map((info) => info.State.Health?.Status),
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (status) => status === until,
            times: 40,
          }),
        );
      });

    for (const [label, cmd, expected] of [
      ["a CMD-SHELL array", ["CMD-SHELL", "test -d /etc"], "healthy"],
      ["a CMD array", ["CMD", "test", "-d", "/etc"], "healthy"],
      ["a failing CMD array", ["CMD", "false"], "unhealthy"],
    ] as const) {
      test.provider(`reports ${expected} for ${label} healthcheck`, (stack) =>
        Effect.gen(function* () {
          const container = yield* stack.deploy(
            Docker.Container(`healthcheck-run-${expected}-${cmd[0].toLowerCase()}`, {
              image: "nginx:alpine",
              healthcheck: { cmd: [...cmd], interval: "1 second", retries: 1 },
              start: true,
            }),
          );
          expect(yield* healthStatus(container.name, expected)).toBe(expected);
        }),
      );
    }

    test.provider("reports the host port Docker assigned to a random publish (#1388)", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const container = yield* stack.deploy(
          Docker.Container("random-port-container", {
            image: "nginx:alpine",
            // `external: 0` = "any free host port".
            ports: [{ external: 0, internal: 80 }],
            start: true,
          }),
        );

        // Before the fix this was 0: the create arg asked for host port 0
        // literally, and the requested binding was then reported over the
        // assigned one.
        const assigned = container.ports["80/tcp"];
        expect(assigned).toBeGreaterThan(0);

        // …and it is the port the container is actually published on.
        const runtime = yield* docker.container.inspect(container.name);
        expect(runtime?.NetworkSettings.Ports?.["80/tcp"]).toEqual(
          expect.arrayContaining([expect.objectContaining({ HostPort: `${assigned}` })]),
        );
      }),
    );

    test.provider("forwards extra hosts to the container (#1387)", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const container = yield* stack.deploy(
          Docker.Container("extra-hosts-container", {
            image: "nginx:alpine",
            extraHosts: ["host.docker.internal:host-gateway", "db.internal:10.1.2.3"],
            start: true,
          }),
        );

        const runtime = yield* docker.container.inspect(container.name);
        expect(runtime?.HostConfig.ExtraHosts).toEqual(
          expect.arrayContaining(["host.docker.internal:host-gateway", "db.internal:10.1.2.3"]),
        );
      }),
    );

    test.provider(
      "disconnects only the networks alchemy connected (#1386)",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const foreign = "alchemy-test-foreign-network";

          const deploy = (attach: boolean) =>
            stack.deploy(
              Effect.gen(function* () {
                const network = yield* Docker.Network("managed-network");
                const container = yield* Docker.Container("managed-container", {
                  image: "nginx:alpine",
                  networks: attach ? [{ name: network.name }] : [],
                });
                return { container, network };
              }),
            );

          const first = yield* deploy(true);

          // A network alchemy never connected the container to — the case a
          // user, compose file, or another tool creates.
          yield* docker.network.create({ name: foreign, driver: "bridge" }).pipe(Effect.ignore);
          yield* Effect.addFinalizer(() => docker.network.remove(foreign).pipe(Effect.ignore));
          yield* docker.network.connect({ network: foreign, container: first.container.name });

          // Drop the managed network from the desired state.
          const second = yield* deploy(false);
          expect(second.container.id).toBe(first.container.id);

          const info = yield* docker.container.inspect(second.container.name);
          const attached = Object.keys(info?.NetworkSettings.Networks ?? {});
          // Ours goes…
          expect(attached).not.toContain(first.network.name);
          // …the foreign one stays. No implicit default bridge was added:
          // the container was created directly on its declared network.
          expect(attached).toContain(foreign);
          expect(attached).not.toContain("bridge");
        }),
      { tags: ["provider:docker:network"], timeout: 240_000 },
    );

    test.provider(
      "recreates a container when an Action-backed environment value changes",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const Environment = Action("ContainerEnvironment", (input: { value: string }) =>
            Effect.succeed(input.value),
          );
          const deployWithEnvironment = (value: string) =>
            stack.deploy(
              Effect.gen(function* () {
                const environment = yield* Environment({ value });
                return yield* Docker.Container("action-env-container", {
                  image: "nginx:alpine",
                  environment: { VALUE: environment },
                  start: false,
                });
              }),
            );

          const first = yield* deployWithEnvironment("first");
          const second = yield* deployWithEnvironment("second");

          expect(second.id).not.toBe(first.id);
          const info = yield* docker.container.inspect(second.name);
          expect(info.Config.Env).toContain("VALUE=second");
          expect(info.Config.Env).not.toContain("VALUE=first");
        }),
    );

    test.provider(
      "recreates a container when a Docker image is rebuilt with the same ref",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const docker = yield* Docker.Docker;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-container-image-",
          });
          const deploy = () =>
            stack.deploy(
              Effect.gen(function* () {
                const image = yield* Docker.Image("container-image", {
                  build: { context: root },
                });
                const container = yield* Docker.Container("rebuilt-image-container", {
                  image,
                  start: false,
                });
                return { container, image };
              }),
            );

          yield* fs.writeFileString(
            path.join(root, "Dockerfile"),
            "FROM nginx:alpine\nLABEL alchemy.generation=first\n",
          );
          const first = yield* deploy();
          yield* fs.writeFileString(
            path.join(root, "Dockerfile"),
            "FROM nginx:alpine\nLABEL alchemy.generation=second\n",
          );
          const second = yield* deploy();

          expect(second.image.imageRef).toBe(first.image.imageRef);
          expect(second.image.imageId).not.toBe(first.image.imageId);
          expect(second.container.id).not.toBe(first.container.id);
          const info = yield* docker.container.inspect(second.container.name);
          expect(info.Image).toBe(second.image.imageId);
        }),
      { timeout: 120_000 },
    );

    // #1990: an image that is still an Output at plan time (here from an
    // Action) must still roll the container when it resolves to a new value.
    test.provider("recreates a container when an Action-resolved image changes", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const Resolve = Action("ContainerImageRef", (input: { image: string }) =>
          Effect.succeed(input.image),
        );
        const deploy = (image: string) =>
          stack.deploy(
            Effect.gen(function* () {
              const ref = yield* Resolve({ image });
              return yield* Docker.Container("action-image-container", {
                image: ref,
                command: ["sleep", "300"],
                start: true,
              });
            }),
          );

        const first = yield* deploy("alpine:3.19");
        const second = yield* deploy("busybox:1.36");
        expect(second.id).not.toBe(first.id);
        expect(second.imageRef).toBe("busybox:1.36");
        expect((yield* docker.container.inspect(second.name)).Config.Image).toBe("busybox:1.36");

        // The same resolved image keeps the container.
        const third = yield* deploy("busybox:1.36");
        expect(third.id).toBe(second.id);
      }),
    );

    test.provider("recreates a managed container deleted outside Alchemy", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = Docker.Container("deleted-container", { image: "alpine:3.22" });
        const first = yield* stack.deploy(resource);
        yield* docker.container.remove(first.id, true);
        expect((yield* stack.plan(resource)).resources["deleted-container"]?.action).toBe("update");
        const second = yield* stack.deploy(resource);
        expect(second.id).not.toBe(first.id);
        expect((yield* docker.container.inspect(second.id)).Id).toBe(second.id);
        yield* stack.destroy();
      }),
    );

    test.provider("refuses a foreign replacement of a previously managed container", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = `alchemy-test-container-replaced-${stack.stage}`;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = Docker.Container("replaced-container", {
          name,
          image: "alpine:3.22",
        });
        const original = yield* stack.deploy(resource);
        yield* docker.container.remove(original.id, true);
        const { stdout } = yield* docker.run([
          "container",
          "create",
          "--name",
          name,
          "alpine:3.22",
        ]);
        const foreignId = stdout.trim();
        yield* Effect.addFinalizer(() =>
          docker.container.remove(foreignId, true).pipe(Effect.ignore),
        );

        const assertRefused = Effect.fn(function* <A, E>(operation: Effect.Effect<A, E>) {
          const conflict = yield* operation.pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(findContainerOwnershipConflict(cause))),
          );
          expect(conflict?._tag).toBe("OwnedBySomeoneElse");
          expect(conflict?.physicalName).toBe(name);
          expect((yield* docker.container.inspect(name)).Id).toBe(foreignId);
        });
        yield* assertRefused(stack.plan(resource));
        yield* assertRefused(stack.deploy(resource));

        yield* docker.container.remove(foreignId, true);
        yield* stack.destroy();
      }),
    );

    test.provider("keeps managing a successor container that carries its own labels", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = `alchemy-test-container-successor-${stack.stage}`;
        yield* stack.destroy();
        yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
        const resource = Docker.Container("successor-container", { name, image: "alpine:3.22" });
        const original = yield* stack.deploy(resource);
        // A recreate whose state write was lost leaves a container with a new
        // ID but this resource's labels under the managed name.
        const labels = (yield* docker.container.inspect(original.id)).Config.Labels ?? {};
        yield* docker.container.remove(original.id, true);
        const { stdout } = yield* docker.run([
          "container",
          "create",
          "--name",
          name,
          ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
          "alpine:3.22",
        ]);
        const successorId = stdout.trim();
        yield* Effect.addFinalizer(() =>
          docker.container.remove(successorId, true).pipe(Effect.ignore),
        );

        // Neither plan nor deploy refuses it as a foreign replacement, and
        // destroy removes it rather than leaking it under the managed name.
        expect((yield* stack.plan(resource)).resources["successor-container"]?.action).toBe("noop");
        yield* stack.deploy(resource);
        expect((yield* docker.container.inspect(name)).Id).toBe(successorId);
        yield* stack.destroy();
        expect((yield* docker.container.inspect(name).pipe(Effect.flip)).reason._tag).toBe(
          "NotFound",
        );
      }),
    );

    test.provider("adopts a container from a named context without removing it", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const context = "alchemy-test-container-adoption";
        const name = "alchemy-test-adopted-container";
        const { stdout: host } = yield* docker.run([
          "context",
          "inspect",
          "--format",
          "{{.Endpoints.docker.Host}}",
        ]);

        yield* docker.context.remove(context, true).pipe(Effect.ignore);
        yield* docker.context.create({
          name: context,
          docker: `host=${host.trim()}`,
        });
        yield* Effect.addFinalizer(() => docker.context.remove(context, true).pipe(Effect.ignore));
        yield* docker.container.remove(name, true, context).pipe(Effect.ignore);
        const { stdout: id } = yield* docker.run([
          "--context",
          context,
          "container",
          "create",
          "--name",
          name,
          "nginx:alpine",
        ]);
        yield* Effect.addFinalizer(() =>
          docker.container.remove(name, true, context).pipe(Effect.ignore),
        );

        const adopted = yield* stack.deploy(
          Docker.Container("adopted-container", {
            name,
            image: "nginx:alpine",
            context,
          }),
        );

        expect(adopted.id).toBe(id);
      }),
    );

    test.provider("updates start state without replacing the container", (stack) =>
      Effect.gen(function* () {
        const first = yield* stack.deploy(
          Docker.Container("started-container", {
            image: "nginx:alpine",
            start: false,
          }),
        );
        const second = yield* stack.deploy(
          Docker.Container("started-container", {
            image: "nginx:alpine",
            start: true,
          }),
        );

        expect(second.id).toBe(first.id);
        expect(second.status).toBe("running");
      }),
    );

    test.provider(
      "updates networks without replacing a container with a host-bound port",
      (stack) =>
        Effect.gen(function* () {
          const hostPort = yield* findAvailablePort();
          const deployWithAlias = (alias: string) =>
            stack.deploy(
              Effect.gen(function* () {
                const network = yield* Docker.Network("host-port-network");
                const container = yield* Docker.Container("host-port-container", {
                  image: "nginx:alpine",
                  ports: [
                    {
                      external: `127.0.0.1:${hostPort}`,
                      internal: 80,
                    },
                  ],
                  networks: [{ name: network.name, aliases: [alias] }],
                });
                return { container, network };
              }),
            );

          const first = yield* deployWithAlias("old-alias");
          const second = yield* deployWithAlias("new-alias");

          expect(second.container.id).toBe(first.container.id);
        }),
    );

    test.provider(
      "reconciles removed environment after a creating-state image prop is lost",
      (stack) =>
        Effect.gen(function* () {
          const docker = yield* Docker.Docker;
          const first = yield* stack.deploy(
            Docker.Container("lost-image-env-container", {
              image: "nginx:alpine",
              environment: { OLD_VALUE: "present" },
            }),
          );

          yield* wedgeContainerRow(stack);

          const second = yield* stack.deploy(
            Docker.Container("lost-image-env-container", {
              image: "nginx:alpine",
            }),
          );
          const info = yield* docker.container.inspect(second.name);

          expect(second.id).not.toBe(first.id);
          expect(info.Config.Env).not.toContain("OLD_VALUE=present");
        }),
    );
  },
);
