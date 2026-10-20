import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { MicrovmEgressSandbox } from "./box.ts";

/** POST /sh with a shell script: its exit code and output. One image per size. */
export default AWS.Lambda.MicrovmSandbox(
  MicrovmEgressSandbox,
  {
    main: import.meta.url,
    sizes: { small: "1 GB", large: "2 GB" },
    cpuConfigurations: [{ architecture: "ARM_64" }],
  },
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const script = yield* request.text;
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", ["-c", script], {
            cwd: "/tmp",
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
        return yield* HttpServerResponse.json({ exitCode, stdout, stderr });
      }).pipe(Effect.scoped, Effect.orDie),
    };
  }),
);
