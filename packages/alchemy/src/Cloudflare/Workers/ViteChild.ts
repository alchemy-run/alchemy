import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";
import * as NodeV8 from "node:v8";
import { registerExitKill } from "../../Util/killProcessGroup.ts";
import { transformTypesFlags } from "../../Util/Node.ts";
import { unwrapRedacted } from "../../Util/index.ts";
import {
  type ViteChildConfig,
  VITE_CHILD_READY_PREFIX,
  VITE_CHILD_READY_SUFFIX,
} from "./ViteChild.shared.ts";

export interface ViteChildHandle {
  readonly url: URL;
  readonly pid: number;
  readonly exitCode: Effect.Effect<number>;
}

const runnerUrl = import.meta.resolve(
  import.meta.url.endsWith(".ts")
    ? "./ViteChildRunner.ts"
    : "./ViteChildRunner.js",
);

export const startViteChild = (
  config: ViteChildConfig,
  onOutput: (channel: "stdout" | "stderr", line: string) => void,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runner = fileURLToPath(runnerUrl);
    const isBun = typeof globalThis.Bun !== "undefined";
    // Redacted values can't cross the process boundary — the config is
    // plain data once unwrapped.
    const serializedConfig = NodeV8.serialize(unwrapRedacted(config));
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        isBun
          ? ["run", runner]
          : [...(runner.endsWith(".ts") ? transformTypesFlags() : []), runner],
        {
          cwd: config.rootDir,
          stdin: Stream.succeed(serializedConfig),
          stdout: "pipe",
          stderr: "pipe",
          extendEnv: true,
          killSignal: "SIGKILL",
        },
      ),
    );
    yield* registerExitKill(child.pid);

    const ready = yield* Deferred.make<URL>();
    yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        const start = line.indexOf(VITE_CHILD_READY_PREFIX);
        const end = line.indexOf(VITE_CHILD_READY_SUFFIX);
        if (start !== -1 && end > start) {
          const value = line.slice(start + VITE_CHILD_READY_PREFIX.length, end);
          return Deferred.succeed(ready, new URL(value));
        }
        return Effect.sync(() => onOutput("stdout", line));
      }),
      Effect.forkScoped,
    );
    yield* child.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Effect.sync(() => onOutput("stderr", line))),
      Effect.forkScoped,
    );

    const exitCode = child.exitCode.pipe(Effect.orDie);
    const url = yield* Effect.raceAllFirst([
      Deferred.await(ready),
      exitCode.pipe(
        Effect.flatMap((exitCode) =>
          Effect.die(
            new Error(
              `Vite child exited with code ${exitCode} before becoming ready`,
            ),
          ),
        ),
      ),
    ]);
    return { url, pid: child.pid, exitCode } satisfies ViteChildHandle;
  });
