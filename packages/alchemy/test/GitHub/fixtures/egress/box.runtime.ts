import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import * as Cloudflare from "@/Cloudflare";
import { EgressBox } from "./box.ts";

export default Cloudflare.Containers.Sandbox(
  EgressBox,
  {
    main: import.meta.url,
    runtime: "node",
    image: "node:22-bookworm-slim",
    sizes: { small: "lite" },
  },
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return {
      // POST /sh with a shell script: its exit code and output.
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
