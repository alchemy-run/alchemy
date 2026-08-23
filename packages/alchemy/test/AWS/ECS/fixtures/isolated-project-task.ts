import * as Effect from "effect/Effect";
import { tmpdir } from "node:os";
import { Task } from "@/AWS/ECS/Task.ts";

/**
 * The "isolated project": a directory outside the repository tree that the
 * test materialises before deploying — a `package.json` plus a `main.ts`
 * that re-exports this module's default export by absolute path.
 *
 * Pointing the task's `main` there makes the bundle's `cwd` (the nearest
 * `package.json`) a directory from which NONE of alchemy's dependencies
 * resolve — the same situation as a consumer project installed with bun's
 * isolated linker (or pnpm), where `@distilled.cloud/aws` and friends live
 * beside `alchemy` rather than in the project's `node_modules`.
 *
 * The module-scope path is deliberately deterministic (no nonce): it has to
 * be known when this module is evaluated — at test collection, before any
 * hook runs — because `main` is a prop of the task declaration below.
 */
export const isolatedProjectDir = `${tmpdir()}/alchemy-test-ecs-isolated-project`;
export const isolatedProjectMain = `${isolatedProjectDir}/main.ts`;

/** Absolute path of this fixture, for the isolated project's re-export. */
export const fixturePath = import.meta.filename;

/**
 * Regression fixture for the generated bun bootstrap's imports: the
 * virtual entry `AWS.ECS.Task` wraps around `main` imports
 * `@distilled.cloud/aws/*`, `@effect/platform-bun`, `alchemy/*` and
 * `effect/*`. A virtual module has no location on disk, so rolldown used to
 * resolve those from the build `cwd` — and from an isolated project it
 * cannot, reported `[UNRESOLVED_IMPORT]`, left them external, and the
 * container died at boot with `Cannot find module …`. The plugin now anchors
 * them on the wrapped entry and on alchemy's own installation.
 *
 * The `{ run }` impl logs a marker and completes, so a successful boot is
 * observable as the Fargate task stopping with container exit code 0.
 */
export class IsolatedProjectTask extends Task<IsolatedProjectTask>()(
  "EcsIsolatedProjectTask",
) {}

export default IsolatedProjectTask.make(
  {
    main: isolatedProjectMain,
    // Docker Hub's `oven/bun`; the public.ecr.aws default mirror rate-limits
    // anonymous pulls during local builds (see fixtures/task.ts).
    image: "oven/bun:1",
    cpu: 256,
    memory: 512,
    // Build/run on ARM64 so an image built on an Apple Silicon host matches
    // the Fargate runtime architecture (Graviton).
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
    taskName: "alchemy-test-ecs-isolated-project",
  },
  Effect.gen(function* () {
    return {
      // One-shot entry: log the marker and exit 0.
      run: Effect.log("alchemy-isolated-project-ran"),
    };
  }),
);
