/**
 * Warm the docker layer cache for the org sandbox MicroVM bake:
 *
 *   bun scripts/warm-bake.ts
 *
 * The floci emulator caps `docker build` at 15 minutes, which the COLD
 * seed build (clone + install + tsc -b + floci package) exceeds. Floci
 * builds through the classic builder against the shared daemon, so
 * building the SAME Dockerfile once here — with the `FROM` rewritten
 * to the local AL2023 base exactly as floci rewrites it — leaves the
 * seed layers (binaries, clone, pnpm store, tsbuildinfo, ~/.m2) in the
 * shared cache. The emulator's build then only runs the incremental
 * TIP layer: minutes, not tens of minutes.
 *
 * Each run passes a fresh REFRESH build-arg, so the tip layer
 * re-converges to origin/main over the warm seed — rerun this script
 * whenever you want the baked snapshot moved up to the branch head.
 * (Between runs the snapshot may lag main; harmless — sessions fetch
 * and land on the tip at claim time.)
 *
 * The bake needs NO build context (the workspace is a network clone;
 * see `SandboxMicrovm.ts`) — the context below is an empty temp dir.
 */
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { SANDBOX_DOCKERFILE } from "../src/SandboxMicrovm.ts";

// mirror MicrovmBuildService.rewriteBaseImage + localBaseImage()
const LOCAL_BASE =
  process.env.FLOCI_MICROVM_BASE_IMAGE ||
  "public.ecr.aws/amazonlinux/amazonlinux:2023";

// tsc -b (TypeScript 7's native tsgo) needs ~8GB by itself; a Docker
// Desktop VM sized below ~10GB SIGKILLs the seed build partway. Fail
// fast with the fix instead of dying 10 minutes in.
const info = Bun.spawnSync(["docker", "info", "--format", "{{.MemTotal}}"]);
const memTotal = Number(info.stdout.toString().trim());
if (Number.isFinite(memTotal) && memTotal > 0) {
  const gib = memTotal / 1024 ** 3;
  if (gib < 10) {
    console.error(
      `docker VM has ${gib.toFixed(1)}GiB of memory — the bake's tsc -b needs ~8GiB and will be OOM-killed.\n` +
        "Raise Docker Desktop memory to 12GiB+ (Settings → Resources → Memory) and rerun.",
    );
    process.exit(1);
  }
}

const { contextDir } = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const contextDir = yield* fs.makeTempDirectory({ prefix: "bake-warm-" });
    const dockerfile =
      SANDBOX_DOCKERFILE.trim().replace(/^FROM .*$/m, `FROM ${LOCAL_BASE}`) +
      "\n";
    yield* fs.writeFileString(
      path.join(contextDir, "Dockerfile.warm"),
      dockerfile,
    );
    return { contextDir };
  }).pipe(Effect.provide(BunServices.layer)),
);

// classic builder (DOCKER_BUILDKIT=0) — floci builds through the same
// engine, so only its cache counts
const build = Bun.spawn(
  [
    "docker",
    "build",
    "--platform",
    "linux/arm64",
    "--build-arg",
    `REFRESH=${Date.now()}`,
    "-f",
    `${contextDir}/Dockerfile.warm`,
    "-t",
    "alchemy-org-bake-warm",
    contextDir,
  ],
  {
    env: { ...process.env, DOCKER_BUILDKIT: "0" },
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await build.exited);
