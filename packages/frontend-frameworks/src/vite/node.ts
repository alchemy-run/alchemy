/**
 * `@alchemy.run/frontend-frameworks/vite/node` — the Node container deploy
 * target for the plain Vite integration.
 *
 * A plain Vite build is assets-only (client bundle + `index.html`), so
 * there is no server entry and no finishing pass. The container composite
 * generates a tiny static-file server from `clientDirectory` when
 * `serverModules` is empty. The target owns exactly one seam: the wholesale
 * `build` hook runs the project's `vite build` in a disposable child process
 * whose working directory IS the project root (see `core/BuildChild.ts`).
 */
import * as Effect from "effect/Effect";
import { runBuildChild } from "../core/BuildChild.ts";
import { NODE_BUNDLE_CONDITIONS } from "../core/NodeServe.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import { make, type ViteTarget, type ViteTargetConfig } from "./Vite.ts";

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

/**
 * The in-child target: no wholesale `build` hook, so the child runs the
 * regular vite-build pipeline (no recursion).
 */
const makeNodeChildTarget = (config: ViteTargetConfig = {}): ViteTarget =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
  });

/** The runner's JSON payload for the build child (see `core/BuildChild.ts`). */
export interface ViteNodeBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: ViteTargetConfig;
}

/** The pure in-child build entry the shared `BuildChildRunner` invokes. */
export const buildInChild = (config: ViteNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      target: makeNodeChildTarget(config.config),
      vite: config.config.vite,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the Node {@link ViteTarget}: the assets-only target whose `build`
 * spawns the vite build in a child process.
 */
export const makeNodeTarget = (config: ViteTargetConfig = {}): ViteTarget => ({
  ...makeNodeChildTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      framework: "vite",
      config: {
        rootDir: context.root,
        config,
      } satisfies ViteNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeNodeTarget;

export default makeNodeTarget;
