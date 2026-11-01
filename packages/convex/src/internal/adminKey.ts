import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

export class AdminKeyNotFound extends Data.TaggedError("AdminKeyNotFound")<{
  readonly message: string;
}> {}

const ADMIN_KEY = /^[a-z0-9-]+\|[0-9a-f]+$/i;

/**
 * Pull the admin key out of `generate_key`'s output, which Docker's pull
 * progress can precede. The error never repeats the output, which may hold it.
 */
export const parseAdminKey = Effect.fn(function* (stdout: string) {
  const key = stdout
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => ADMIN_KEY.test(line));
  if (key === undefined) {
    return yield* new AdminKeyNotFound({
      message: "generate_key printed no admin key. Check the image is a Convex backend.",
    });
  }
  return Redacted.make(key);
});

export class DockerUnavailable extends Data.TaggedError("DockerUnavailable")<{
  readonly message: string;
}> {}

export class AdminKeyMintFailed extends Data.TaggedError("AdminKeyMintFailed")<{
  readonly message: string;
}> {}

/**
 * Run `generate_key`, which only exists in the backend image. The name and
 * secret travel in the environment, so neither reaches `argv`.
 */
export const mintAdminKey = Effect.fn(function* (
  spawner: ChildProcessSpawner["Service"],
  input: { image: string; instanceName: string; instanceSecret: Redacted.Redacted<string> },
  docker = "docker",
) {
  const secret = Redacted.value(input.instanceSecret);
  const dockerUnavailable = new DockerUnavailable({
    message:
      "Minting a Convex admin key needs Docker on the deploying machine. Install or start Docker and deploy again.",
  });
  const { exitCode, stdout, stderr } = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          docker,
          [
            "run",
            "--rm",
            "-e",
            "INSTANCE_NAME",
            "-e",
            "INSTANCE_SECRET",
            "--entrypoint",
            "sh",
            input.image,
            "-c",
            './generate_key "$INSTANCE_NAME" "$INSTANCE_SECRET"',
          ],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { INSTANCE_NAME: input.instanceName, INSTANCE_SECRET: secret },
            extendEnv: true,
          },
        ),
      );
      return yield* Effect.all(
        {
          exitCode: child.exitCode,
          stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
          stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
        },
        { concurrency: "unbounded" },
      );
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () =>
        Effect.fail(
          new AdminKeyMintFailed({ message: `generate_key timed out for ${input.image}.` }),
        ),
    }),
    Effect.catchTag("PlatformError", () => Effect.fail(dockerUnavailable)),
  );
  if (exitCode !== 0) {
    const cause = stderr.replaceAll(secret, "[REDACTED]").trim();
    return yield* cause.includes("Cannot connect to the Docker daemon")
      ? Effect.fail(dockerUnavailable)
      : Effect.fail(
          new AdminKeyMintFailed({ message: `generate_key failed for ${input.image}: ${cause}` }),
        );
  }
  return yield* parseAdminKey(stdout);
});
