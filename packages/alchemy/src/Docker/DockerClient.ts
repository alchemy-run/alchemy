import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  PlatformError,
  SystemError,
  type SystemErrorTag,
} from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export class Docker extends Context.Service<
  Docker,
  {
    readonly run: (
      args: Array<string>,
    ) => Effect.Effect<CommandOutput, PlatformError>;
    readonly materialize: (options: {
      context: string;
      dockerfile: string;
      files: ReadonlyArray<{
        path: string;
        content: string | Uint8Array;
      }>;
    }) => Effect.Effect<void, PlatformError>;
    readonly container: {
      readonly create: (options: {
        name: string;
        image: string;
        volume: Array<string> | undefined;
        env: Record<string, string> | undefined;
        restart: "no" | "always" | "on-failure" | "unless-stopped";
        rm: boolean;
        "health-cmd": string | undefined;
        "health-interval": string | undefined;
        "health-timeout": string | undefined;
        "health-retries": number | undefined;
        "health-start-period": string | undefined;
        "health-start-interval": string | undefined;
        p: Array<string> | undefined;
        command: Array<string> | undefined;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      readonly inspect: (
        name: string,
      ) => Effect.Effect<Docker.ContainerInfo, PlatformError>;
      readonly remove: (
        name: string,
        force?: boolean,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      readonly start: (
        name: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      readonly stop: (
        name: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
    readonly image: {
      readonly build: (options: {
        context: string;
        tag: string;
        file?: string;
        platform?: string;
        target?: string;
        "build-arg"?: Record<string, string>;
        "cache-from"?: Array<string>;
        "cache-to"?: Array<string>;
        args?: Array<string>;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      readonly pull: (
        ref: string,
        platform?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      readonly push: (
        ref: string,
        credentials: {
          server: string;
          username: string;
          password: string | Redacted.Redacted<string>;
        },
      ) => Effect.Effect<CommandOutput, PlatformError>;
      readonly tag: (
        source: string,
        target: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      readonly inspect: (
        ref: string,
      ) => Effect.Effect<Docker.InspectedImage, PlatformError>;
      readonly remove: (
        ref: string | Array<string>,
        force?: boolean,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
    readonly volume: {
      readonly create: (options: {
        name: string;
        driver?: string;
        opt?: Record<string, string>;
        label?: Record<string, string>;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      readonly remove: (
        name: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      readonly inspect: (
        name: string,
      ) => Effect.Effect<Docker.InspectedVolume, PlatformError>;
    };
    readonly network: {
      readonly create: (options: {
        name: string;
        driver: string;
        ipv6?: boolean;
        label?: Record<string, string>;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      readonly connect: (options: {
        network: string;
        container: string;
        alias?: string[];
      }) => Effect.Effect<CommandOutput, PlatformError>;
      readonly disconnect: (options: {
        network: string;
        container: string;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      readonly inspect: (
        name: string,
      ) => Effect.Effect<Docker.InspectedNetwork, PlatformError>;
      readonly remove: (
        id: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
  }
>()("@alchemy/docker/client") {}

export declare namespace Docker {
  export type ContainerStatus =
    | "created"
    | "running"
    | "paused"
    | "restarting"
    | "removing"
    | "exited"
    | "dead";

  export interface ContainerInfo {
    Id: string;
    Name?: string;
    State: { Status: ContainerStatus };
    Created: string;
    Config: {
      Image: string;
      Cmd: string[] | null;
      Env: string[] | null;
      Healthcheck?: {
        Test: string[] | null;
        Interval?: number;
        Timeout?: number;
        Retries?: number;
        StartPeriod?: number;
        StartInterval?: number;
      } | null;
    };
    HostConfig: {
      PortBindings: Record<
        string,
        Array<{ HostIp: string; HostPort: string }> | null
      > | null;
      Binds: string[] | null;
      RestartPolicy: {
        Name: string;
        MaximumRetryCount: number;
      };
      AutoRemove: boolean;
    };
    NetworkSettings: {
      Networks: Record<
        string,
        {
          NetworkID: string;
          Aliases: string[] | null;
        }
      > | null;
      Ports?: Record<
        string,
        Array<{ HostIp: string; HostPort: string }> | null
      > | null;
    };
  }

  export interface InspectedImage {
    Id: string;
    Created?: string;
    RepoTags?: string[] | null;
    RepoDigests?: string[] | null;
  }
  export interface InspectedVolume {
    CreatedAt: string;
    Driver: string;
    Labels: Record<string, string> | null;
    Mountpoint: string;
    Name: string;
    Options: Record<string, string> | null;
    Scope: string;
  }
  export interface InspectedNetwork {
    Name: string;
    Id: string;
    Created: string;
    Scope: string;
    Driver: string;
    EnableIPv6: boolean;
    Labels: Record<string, string> | null;
  }
}

interface CommandOutput {
  exitCode: ChildProcessSpawner.ExitCode;
  stdout: string;
  stderr: string;
}

const DockerBin = Config.string("DOCKER_BIN").pipe(
  Effect.orElseSucceed(() => "docker"),
);

export const DockerLive = Layer.effect(
  Docker,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const bin = yield* DockerBin;

    const run = (args: Array<string>, env?: Record<string, string>) =>
      ChildProcess.make(bin, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
        env,
        extendEnv: true,
      }).pipe(
        spawner.spawn,
        Effect.flatMap((child) =>
          Effect.all(
            {
              exitCode: child.exitCode,
              stdout: child.stdout.pipe(
                Stream.decodeText,
                Stream.tap(Effect.logDebug),
                Stream.mkString,
                Effect.map((stdout) => stdout.trim()),
              ),
              stderr: child.stderr.pipe(
                Stream.decodeText,
                Stream.tap(Effect.logDebug),
                Stream.mkString,
                Effect.map((stderr) => stderr.trim()),
              ),
            },
            { concurrency: "unbounded" },
          ),
        ),
        Effect.mapError((error) =>
          systemError({
            _tag: "Unknown",
            args,
            description: "The command failed unexpectedly.",
            cause: error.reason,
          }),
        ),
        Effect.tap((result) => {
          if (result.exitCode === 0) return Effect.void;
          const stderr = result.stderr.replace(
            /^Error response from daemon: /,
            "",
          );
          if (stderr.match(/no such/i) || stderr.match(/not found/i)) {
            return systemError({
              _tag: "NotFound",
              args,
              description: stderr,
            });
          }
          if (stderr.match(/already exists/i)) {
            return systemError({
              _tag: "AlreadyExists",
              args,
              description: stderr,
            });
          }
          return systemError({
            _tag: "Unknown",
            args,
            description: `Command exited with code ${result.exitCode}: ${stderr}`,
          });
        }),
        Effect.scoped,
      );

    const systemError = (input: {
      _tag: SystemErrorTag;
      args: Array<string>;
      description?: string;
      cause?: unknown;
    }) =>
      new PlatformError(
        new SystemError({
          _tag: input._tag,
          module: "Docker",
          method: input.args.slice(0, 2).join("."),
          pathOrDescriptor: input.args[2],
          description: input.description,
          cause: input.cause,
        }),
      );

    const runInspect = <T>(args: Array<string>) =>
      run(args).pipe(
        Effect.map((result) => {
          const [item] = JSON.parse(result.stdout) as T[];
          return item;
        }),
      );

    const argsFrom = (
      options: Record<
        string,
        | boolean
        | string
        | number
        | undefined
        | Record<string, string>
        | Array<string>
      >,
    ) => {
      const args: Array<string> = [];
      for (const [key, value] of Object.entries(options)) {
        if (!value) continue;
        const prefix = key.length > 1 ? `--${key}` : `-${key}`;
        if (value === true) {
          args.push(prefix);
        } else if (typeof value === "string") {
          args.push(prefix, value);
        } else if (typeof value === "number") {
          args.push(prefix, String(value));
        } else if (Array.isArray(value)) {
          for (const item of value) {
            args.push(prefix, item);
          }
        } else if (value !== null && typeof value === "object") {
          for (const [k, v] of Object.entries(value)) {
            args.push(prefix, `${k}=${v}`);
          }
        }
      }
      return args;
    };

    return Docker.of({
      run,
      materialize: Effect.fn((options) =>
        Effect.forEach(
          [
            ...options.files,
            { path: "Dockerfile", content: options.dockerfile },
          ],
          (file) => {
            const fullPath = path.join(options.context, file.path);
            return fs
              .makeDirectory(path.dirname(fullPath), { recursive: true })
              .pipe(
                Effect.andThen(
                  typeof file.content === "string"
                    ? fs.writeFileString(fullPath, file.content)
                    : fs.writeFile(fullPath, file.content),
                ),
              );
          },
          { concurrency: "unbounded" },
        ),
      ),
      container: {
        create: ({ image, env, ...options }) =>
          run(
            [
              "container",
              "create",
              ...argsFrom({
                ...options,
                env: env ? Object.keys(env) : undefined,
              }),
              image,
              ...(options.command ?? []),
            ],
            env,
          ),
        inspect: (name) =>
          runInspect<Docker.ContainerInfo>(["container", "inspect", name]),
        remove: (name, force) =>
          run(["container", "rm", name, ...(force ? ["-f"] : [])]),
        start: (name) => run(["container", "start", name]),
        stop: (name) => run(["container", "stop", name]),
      },
      image: {
        build: ({ context, args, ...options }) =>
          run([
            "image",
            "build",
            context,
            ...argsFrom(options),
            ...(args ?? []),
          ]),
        pull: (ref, platform) =>
          run([
            "image",
            "pull",
            ref,
            ...(platform ? ["--platform", platform] : []),
          ]),
        inspect: (ref) =>
          runInspect<Docker.InspectedImage>(["image", "inspect", ref]),
        remove: (ref, force) =>
          run([
            "image",
            "rm",
            ...(Array.isArray(ref) ? ref : [ref]),
            ...(force ? ["-f"] : []),
          ]),
        tag: (source, target) => run(["image", "tag", source, target]),
        push: Effect.fn(function* (ref, credentials) {
          // Write the registry credentials directly into an isolated docker config
          // as a plaintext `auths` entry and skip `docker login` entirely.
          //
          // `docker login` is the wrong tool here: on macOS Docker Desktop it routes
          // through the shared `osxkeychain`/`desktop` credential helper *regardless*
          // of an isolated DOCKER_CONFIG, so concurrent deploys either race the system
          // keychain (`The specified item already exists in the keychain (-25299)`) or
          // land the credential in the helper — leaving this isolated config without
          // an `auths` entry, so the subsequent `docker push` fails with "no basic
          // auth credentials". Embedding the base64 `auth` inline (the same thing
          // `docker login` would write when no credsStore is configured) makes each
          // deploy fully self-contained: no credential helper, no keychain, no login
          // race. Only `push` reads this config; `build`/`pull`/`tag` keep using the
          // global docker config (buildx builders, `docker context`, etc. intact).
          const dir = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-docker-",
          });
          yield* fs.writeFileString(
            path.join(dir, "config.json"),
            JSON.stringify({
              auths: {
                [credentials.server]: {
                  auth: Buffer.from(
                    `${credentials.username}:${Redacted.isRedacted(credentials.password) ? Redacted.value(credentials.password) : credentials.password}`,
                  ).toString("base64"),
                },
              },
            }),
          );
          return yield* run(["push", ref], { DOCKER_CONFIG: dir });
        }, Effect.scoped),
      },
      volume: {
        create: (options) => run(["volume", "create", ...argsFrom(options)]),
        remove: (name) => run(["volume", "rm", name]),
        inspect: (name) =>
          runInspect<Docker.InspectedVolume>(["volume", "inspect", name]),
      },
      network: {
        create: ({ name, driver, ipv6, label }) =>
          run([
            "network",
            "create",
            name,
            ...argsFrom({ driver, ipv6, label }),
          ]),
        connect: ({ network, container, alias }) =>
          run([
            "network",
            "connect",
            network,
            container,
            ...(alias ? alias.flatMap((a) => ["--alias", a]) : []),
          ]),
        disconnect: ({ network, container }) =>
          run(["network", "disconnect", network, container]),
        inspect: (name) =>
          runInspect<Docker.InspectedNetwork>(["network", "inspect", name]),
        remove: (id) => run(["network", "rm", id]),
      },
    });
  }),
);
