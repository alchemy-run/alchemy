/**
 * Node images for pools whose nodes are plain VMs (Compute Engine, EC2,
 * Hetzner): with no registry between the deploy and the node, the image is
 * built locally for the VM's platform and saved to a tarball the VM loads
 * into its own Docker.
 *
 * @internal
 */
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import type { ImageProgram } from "./PoolHost.ts";
import { stackDnsLabel } from "./PoolHost.ts";

/** The `docker` CLI exited non-zero while building or saving a node image. */
export class NodeImageBuildFailed extends Data.TaggedError("Rivet.NodeImageBuildFailed")<{
  readonly message: string;
}> {}

/** Run the `docker` CLI, failing with its output when it exits non-zero. */
const docker = Effect.fn("Rivet.docker")(function* (args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("docker", args, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      extendEnv: true,
    }),
  );
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      child.exitCode,
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
      child.stderr.pipe(Stream.decodeText, Stream.mkString),
    ],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0) {
    return yield* new NodeImageBuildFailed({
      message: `docker ${args[0]} exited with ${exitCode}: ${(stderr || stdout).trim().slice(-800)}`,
    });
  }
  return stdout.trim();
}, Effect.scoped);

/**
 * The script lines a VM runs to load the tarball at `$1`-style `path` and
 * set `IMAGE` to the image it holds.
 */
export const loadNodeImage = (path: string) =>
  `IMAGE="$(docker load -i ${path} | sed -n 's/^Loaded image: //p' | tail -1)"`;

/**
 * Build `program` for `platform` and save it to a tarball, once the deploy
 * resolves it, and resolve to the tarball's path. The image is tagged
 * `rivet-node-<pool>:latest`, the name `docker load` reports on the VM.
 */
export const saveNodeImage = Effect.fn(function* (
  host: string,
  id: string,
  program: ImageProgram,
  platform: "linux/amd64" | "linux/arm64",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const label = yield* stackDnsLabel(id);
  const dir = path.resolve(yield* dotAlchemyDirectory, "rivet", host, label);
  const tag = `rivet-node-${label}:latest`;
  return Output.literal(program).pipe(
    Output.mapEffect((image: ImageProgram) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(dir, { recursive: true });
        const tarball = path.join(dir, "node.tar");
        yield* docker([
          "build",
          "--platform",
          platform,
          "-t",
          tag,
          "-f",
          image.dockerfile,
          image.context,
        ]);
        yield* docker(["save", tag, "-o", tarball]);
        return tarball;
      }).pipe(Effect.orDie),
    ),
  );
});
