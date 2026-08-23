import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * An "isolated project": a throwaway consumer project OUTSIDE the repository
 * tree whose `main.ts` re-exports a test fixture by absolute path.
 *
 * Every `main`-bundled platform (ECS, App Runner, Batch, EC2, Lambda,
 * Cloudflare Containers, Docker, Fly, Hetzner, Prisma, …) wraps the user's
 * program in a generated bootstrap — a *virtual* rolldown module that imports
 * `@distilled.cloud/*`, `@effect/platform-*`, `alchemy/*` and `effect/*`. A
 * virtual module has no directory, so rolldown resolves those from the build
 * `cwd`, i.e. the nearest `package.json` above `main`. Inside this monorepo
 * that is `packages/alchemy`, from which everything resolves — so a fixture
 * checked in next to its test can never reproduce the consumer-side failure:
 * a project installed with bun's isolated linker (or pnpm), where alchemy's
 * own dependencies live beside `alchemy` rather than in the project's
 * `node_modules`, leaves the bootstrap's imports `[UNRESOLVED_IMPORT]`,
 * external, and the deployed process dies at boot with `Cannot find module`.
 *
 * Pointing a fixture's `main` at {@link IsolatedProject.main} makes the bundle
 * `cwd` a directory from which NOTHING bare resolves. The fixture itself (and
 * the user code it represents) is reached through the absolute-path
 * re-export, so its imports still resolve from the repo as usual — only the
 * bootstrap's own imports are exercised, exactly as for a real consumer.
 *
 * The location is deterministic (no nonce) and computed at module scope
 * because `main` is a prop of the fixture's declaration: it has to be known
 * when the fixture module is evaluated, at test collection, before any hook
 * runs. A plain `/tmp` prefix (not `os.tmpdir()`) keeps fixture modules free
 * of Node builtins — Worker/Durable Object bundles import the container
 * fixture for its class and run on workerd.
 */
export interface IsolatedProject {
  /** Unique project name; also the directory name under the shared root. */
  readonly name: string;
  /** Project directory (outside the repository). */
  readonly dir: string;
  /** The `main` to hand to the platform resource. */
  readonly main: string;
  /** Absolute path of the fixture module `main.ts` re-exports. */
  readonly fixture: string;
}

const ROOT = "/tmp/alchemy-test-isolated-projects";

/**
 * Declare an isolated project for `fixture` (pass `import.meta.filename`).
 * Pure: nothing is written until {@link materializeIsolatedProject}.
 */
export const isolatedProject = (
  name: string,
  fixture: string,
): IsolatedProject => {
  const dir = `${ROOT}/${name}`;
  return { name, dir, main: `${dir}/main.ts`, fixture };
};

/**
 * Write the project to disk: a `package.json` (so the bundle `cwd` stops
 * here) and a `main.ts` re-exporting the fixture's default export.
 * Idempotent — safe to call at the top of every test that deploys it.
 */
export const materializeIsolatedProject = (project: IsolatedProject) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(project.dir, { recursive: true });
    yield* fs.writeFileString(
      `${project.dir}/package.json`,
      JSON.stringify({
        name: `alchemy-test-isolated-${project.name}`,
        private: true,
        type: "module",
      }),
    );
    yield* fs.writeFileString(
      project.main,
      `export { default } from ${JSON.stringify(project.fixture)};\n`,
    );
  });

/** Remove the project directory (ignores a missing directory). */
export const removeIsolatedProject = (project: IsolatedProject) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(project.dir, { recursive: true })),
    Effect.ignore,
  );
