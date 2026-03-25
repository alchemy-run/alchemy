import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Undici from "@effect/platform-node/Undici";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

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
  readonly message: string;
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
        message: `Docker command failed (${exitCode}): ${command}\n${stderr}`.trim(),
      }),
    );
  }

  return {
    stdout,
    stderr,
  };
});

const parseImageRef = (ref: string): { name: string; tag: string } => {
  const slashIdx = ref.lastIndexOf("/");
  const colonIdx = ref.lastIndexOf(":");
  if (colonIdx > slashIdx) {
    return {
      name: ref.substring(0, colonIdx),
      tag: ref.substring(colonIdx + 1),
    };
  }
  return { name: ref, tag: "latest" };
};

const getDockerSocketPath = (): string => {
  const host = process.env.DOCKER_HOST;
  if (!host) return "/var/run/docker.sock";
  if (host.startsWith("unix://")) return host.substring(7);
  return "/var/run/docker.sock";
};

const utf8JsonToBase64 = (json: string): string => {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
};

const dockerPushHttpLayer = (socketPath: string) =>
  NodeHttpClient.layerUndiciNoDispatcher.pipe(
    Layer.provide(
      Layer.effect(NodeHttpClient.Dispatcher)(
        Effect.acquireRelease(
          Effect.sync(
            () => new Undici.Agent({ connect: { path: socketPath } }),
          ),
          (dispatcher) => Effect.promise(() => dispatcher.destroy()),
        ),
      ),
    ),
  );

/**
 * Push a Docker image via the Docker daemon REST API with per-request
 * registry credentials, avoiding the shared `docker login` state.
 */
export const pushImageViaDockerApi = Effect.fn(function* (
  imageRef: string,
  auth: { username: string; password: string; serverAddress: string },
) {
  const { name, tag } = parseImageRef(imageRef);
  const authHeader = utf8JsonToBase64(
    JSON.stringify({
      username: auth.username,
      password: auth.password,
      serveraddress: auth.serverAddress,
    }),
  );

  const socketPath = getDockerSocketPath();
  const encodedName = encodeURIComponent(name);
  const apiPath = `/images/${encodedName}/push?tag=${encodeURIComponent(tag)}`;
  const url = `http://localhost${apiPath}`;

  const layer = dockerPushHttpLayer(socketPath);
  const request = HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeader("X-Registry-Auth", authHeader),
  );

  const response = yield* HttpClient.execute(request).pipe(
    Effect.provide(layer),
    Effect.mapError(
      (error) =>
        new DockerCommandError({
          command: `docker push ${imageRef}`,
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
          message: `Docker push failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    ),
  );

  const body = yield* response.text.pipe(
    Effect.mapError(
      (error) =>
        new DockerCommandError({
          command: `docker push ${imageRef}`,
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
          message: `Docker push failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    ),
  );

  if (response.status >= 400) {
    return yield* Effect.fail(
      new DockerCommandError({
        command: `docker push ${imageRef}`,
        stderr: body,
        exitCode: 1,
        message: `Docker push failed: HTTP ${response.status}: ${body}`,
      }),
    );
  }

  const lines = body.split("\n").filter(Boolean);
  let digest = "";
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as {
        error?: string;
        errorDetail?: { message?: string };
        aux?: { Digest?: string };
      };
      if (msg.error || msg.errorDetail) {
        return yield* Effect.fail(
          new DockerCommandError({
            command: `docker push ${imageRef}`,
            stderr: msg.error ?? msg.errorDetail?.message ?? "push failed",
            exitCode: 1,
            message: `Docker push failed: ${msg.error ?? msg.errorDetail?.message ?? "push failed"}`,
          }),
        );
      }
      if (msg.aux?.Digest) {
        digest = msg.aux.Digest;
      }
    } catch {
      // non-JSON progress line
    }
  }

  return digest;
});
