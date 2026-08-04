/**
 * A Worker whose `main` is derived from another resource's output (the
 * `Command.Build` → Worker pattern) reaches `WorkerProvider.precreate`
 * with `main` still an unresolved Output — precreate runs on raw props
 * before upstream outputs resolve. `getCompatibility` must tolerate that
 * (#1049): the placeholder is a JS stub regardless, and `reconcile`
 * re-derives compatibility from the evaluated props.
 */
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Command from "@/Command/index.ts";
import * as Output from "@/Output.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const MARKER = "alchemy-output-main-e2e-ok-7c31";

test.provider(
  "deploys a Worker whose main is derived from a Command.Build output",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      // The entry module only exists after the build command runs, so the
      // Worker cannot know its `main` path until `build.outdir` resolves.
      const tempDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-output-main-",
      });
      yield* fs.writeFileString(
        path.join(tempDir, "worker.src.mjs"),
        `export default { fetch: () => new Response(${JSON.stringify(MARKER)}) };\n`,
      );
      yield* fs.writeFileString(
        path.join(tempDir, "build.sh"),
        "mkdir -p dist\ncp worker.src.mjs dist/worker.mjs\n",
      );

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          const build = yield* Command.Build("OutputMainBuild", {
            command: "bash build.sh",
            cwd: tempDir,
            outdir: "dist",
          });
          return yield* Cloudflare.Worker("OutputMainWorker", {
            isExternal: true,
            workersDev: true,
            main: Output.map(build.outdir, (dir) =>
              pathe.resolve(dir, "worker.mjs"),
            ),
          });
        }),
      );

      expect(worker.url).toBeDefined();
      yield* expectUrlContains(worker.url!, MARKER);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);
