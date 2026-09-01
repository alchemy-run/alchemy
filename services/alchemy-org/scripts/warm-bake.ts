/**
 * Warm the docker layer cache for the org sandbox MicroVM bake:
 *
 *   bun scripts/warm-bake.ts
 *
 * The floci emulator caps `docker build` at 15 minutes, which a COLD
 * bake (binary installs + pnpm store fetch) can exceed. Floci builds
 * through the classic builder against the shared daemon, so building
 * the SAME Dockerfile once here — over the SAME staged workspace
 * (`SandboxBake.ts`), with the `FROM` rewritten to the local AL2023
 * base exactly as floci rewrites it — leaves every heavy layer in the
 * shared cache: the emulator's build then completes in seconds to a
 * few minutes (the tree COPY + linux node_modules link).
 */
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { stageBake } from "../src/SandboxBake.ts";
import { SANDBOX_DOCKERFILE } from "../src/SandboxMicrovm.ts";

// mirror MicrovmBuildService.rewriteBaseImage + localBaseImage()
const LOCAL_BASE =
  process.env.FLOCI_MICROVM_BASE_IMAGE ||
  "public.ecr.aws/amazonlinux/amazonlinux:2023";

const { contextDir } = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bake = yield* stageBake;
    const contextDir = path.dirname(bake.dir);
    // first FROM only, PRESERVING the stage alias (`FROM <image> AS base`)
    // — the multi-stage workspace/final stages reference it
    const dockerfile =
      SANDBOX_DOCKERFILE.trim().replace(
        /^FROM \S+([^\n]*)$/m,
        `FROM ${LOCAL_BASE}$1`,
      ) + "\n";
    yield* fs.writeFileString(
      path.join(contextDir, "Dockerfile.warm"),
      dockerfile,
    );
    console.log(`staged ${bake.fingerprint} at ${bake.dir}`);
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
