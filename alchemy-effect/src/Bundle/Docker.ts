import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export type DockerInstruction =
  | readonly ["run", string]
  | readonly ["copy", string, string]
  | readonly ["workdir", string]
  | readonly ["env", string, string]
  | readonly ["expose", string | number]
  | readonly ["user", string]
  | readonly ["cmd", ...string[]]
  | readonly ["entrypoint", ...string[]];

export interface DockerImageSpec {
  base?: string;
  instructions?: readonly DockerInstruction[];
  entrypoint?: readonly string[];
  cmd?: readonly string[];
}

export class DockerCommandError extends Data.TaggedError("DockerCommandError")<{
  readonly command: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {}

const quote = (value: string) => JSON.stringify(value);

const renderInstruction = (instruction: DockerInstruction): string => {
  const [kind, ...args] = instruction;
  switch (kind) {
    case "run":
      return `RUN ${args[0]}`;
    case "copy":
      return `COPY ${quote(String(args[0]))} ${quote(String(args[1]))}`;
    case "workdir":
      return `WORKDIR ${String(args[0])}`;
    case "env":
      return `ENV ${String(args[0])}=${quote(String(args[1]))}`;
    case "expose":
      return `EXPOSE ${String(args[0])}`;
    case "user":
      return `USER ${String(args[0])}`;
    case "cmd":
      return `CMD ${JSON.stringify(args)}`;
    case "entrypoint":
      return `ENTRYPOINT ${JSON.stringify(args)}`;
  }
};

export const renderDockerfile = (spec: DockerImageSpec): string => {
  const lines = [`FROM ${spec.base ?? "public.ecr.aws/docker/library/bun:1"}`];
  for (const instruction of spec.instructions ?? []) {
    lines.push(renderInstruction(instruction));
  }
  if (spec.entrypoint && spec.entrypoint.length > 0) {
    lines.push(`ENTRYPOINT ${JSON.stringify(spec.entrypoint)}`);
  }
  if (spec.cmd && spec.cmd.length > 0) {
    lines.push(`CMD ${JSON.stringify(spec.cmd)}`);
  }
  return `${lines.join("\n")}\n`;
};

export const writeDockerContext = Effect.fn(function* ({
  directory,
  dockerfile,
  files,
}: {
  directory: string;
  dockerfile: string;
  files: ReadonlyArray<{ path: string; content: string | Uint8Array }>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, "Dockerfile"), dockerfile);

  for (const file of files) {
    const fullPath = path.join(directory, file.path);
    yield* fs.makeDirectory(path.dirname(fullPath), { recursive: true });
    if (typeof file.content === "string") {
      yield* fs.writeFileString(fullPath, file.content);
    } else {
      yield* fs.writeFile(fullPath, file.content);
    }
  }
});

export const runDockerCommand = Effect.fn(function* (
  args: ReadonlyArray<string>,
  options?: { cwd?: string; env?: Record<string, string | undefined> },
) {
  const command = `docker ${args.join(" ")}`;
  const subprocess = Bun.spawn(["docker", ...args], {
    cwd: options?.cwd,
    env: {
      ...process.env,
      ...options?.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = yield* Effect.all([
    Effect.promise(() => new Response(subprocess.stdout).text()),
    Effect.promise(() => new Response(subprocess.stderr).text()),
    Effect.promise(() => subprocess.exited),
  ]);

  if (exitCode !== 0) {
    return yield* Effect.fail(
      new DockerCommandError({
        command,
        stderr,
        exitCode,
      }),
    );
  }

  return {
    stdout,
    stderr,
  };
});
