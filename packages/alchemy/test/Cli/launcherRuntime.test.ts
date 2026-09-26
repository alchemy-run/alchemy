import { PlatformServices } from "@/Util/PlatformServices.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import { nodePath, nodeSupportsDevMode } from "../nodeProbe.ts";

// The launcher picks bun from `npm_execpath` by its file name only: pnpm
// installed under a home directory like `/home/ubuntu/` must still run on
// node (the path contains "bun", which used to select bun).
it.live.skipIf(!nodeSupportsDevMode)(
  "a pnpm path containing 'bun' still runs on node",
  () =>
    Effect.gen(function* () {
      const cli = fileURLToPath(new URL("../../bin/cli.js", import.meta.url));
      const handle = yield* ChildProcess.make(nodePath!, [cli, "--version"], {
        env: {
          NO_COLOR: "1",
          npm_execpath: "/home/ubuntu/.local/share/pnpm/pnpm.cjs",
          npm_config_user_agent: "pnpm/11.25.0 npm/? node/v24.0.0 linux x64",
        },
        extendEnv: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGKILL",
      });
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          ),
          handle.stderr.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          ),
          handle.exitCode,
        ],
        { concurrency: 3 },
      );
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/alchemy v.*\(node /);
    }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
  { tags: ["local"], timeout: 60_000 },
);
