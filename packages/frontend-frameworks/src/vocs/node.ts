/**
 * `@alchemy.run/frontend-frameworks/vocs/node` — the Node container deploy
 * target for Vocs.
 *
 * Vocs docs are prerendered static HTML. The target runs the vocs build in
 * a disposable child process (cwd = project root) with waku's node adapter
 * so SSG can run, then drops `serverModules` so the deploy is assets-only.
 * The container composite generates a tiny static-file server from
 * `clientDirectory` (extensionless HTML: `/about` → `about/index.html`).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodePath from "node:path";
import { runBuildChild } from "../core/BuildChild.ts";
import { NODE_BUNDLE_CONDITIONS } from "../core/NodeServe.ts";
import {
  DeployTargetError,
  Framework,
  makeDeployTarget,
  type Framework as FrameworkService,
} from "../core/index.ts";
import type { VocsTarget } from "./Target.ts";
import { make as makeVocsLayer } from "./Vocs.ts";

export interface VocsNodeTargetConfig {}

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

/**
 * The in-child target: adapter + empty vite plugins, no wholesale `build`
 * (the child runs the regular vocs pipeline). `finish` drops server
 * modules so the output is assets-only.
 */
const makeNodeAdapterTarget = (
  config: VocsNodeTargetConfig = {},
): VocsTarget<VocsNodeTargetConfig> =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    adapter: (context) =>
      Effect.succeed(
        NodePath.join(context.wakuDirectory, "dist/adapters/node.js"),
      ),
    vitePlugins: () => Effect.sync(() => []),
    finish: (output) => Effect.succeed({ ...output, serverModules: undefined }),
  });

export interface VocsNodeBuildChildConfig {
  readonly rootDir: string;
  readonly config: VocsNodeTargetConfig;
}

export const buildInChild = (config: VocsNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* Framework.pipe(
      Effect.provide(
        makeVocsLayer({
          root: config.rootDir,
          target: makeNodeAdapterTarget(config.config),
        }),
      ),
    );
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the Node {@link VocsTarget}: assets-only output whose `build`
 * spawns the vocs build in a child process.
 */
export const makeNodeTarget = (
  config: VocsNodeTargetConfig = {},
): VocsTarget<VocsNodeTargetConfig> => ({
  ...makeNodeAdapterTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      framework: "vocs",
      config: {
        rootDir: context.root,
        config,
      } satisfies VocsNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

export const target = makeNodeTarget;

export default makeNodeTarget;

export interface VocsNodeFrameworkOptions {
  readonly root?: string | undefined;
  readonly target?: string | undefined;
  readonly outDir?: string | undefined;
}

/**
 * Framework-module contract used by container Website composites
 * (`module.make(...)` returns `{ build, dev }`, not a Layer).
 */
export const make = (options: VocsNodeFrameworkOptions = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const resolveRoot = (override: string | undefined) =>
      path.resolve(override ?? options.root ?? process.cwd());

    const withFramework = <A, E, R>(
      root: string,
      use: (framework: FrameworkService["Service"]) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const framework = yield* Framework.pipe(
          Effect.provide(
            makeVocsLayer({
              root,
              target: makeNodeAdapterTarget({}),
            }),
          ),
        );
        return yield* use(framework);
      });

    return {
      build: (buildOptions?: { readonly root?: string }) => {
        const root = resolveRoot(buildOptions?.root);
        return withFramework(root, (framework) => framework.build({ root }));
      },
      dev: (devOptions?: {
        readonly root?: string;
        readonly port?: number;
        readonly host?: string;
      }) => {
        const root = resolveRoot(devOptions?.root);
        return withFramework(root, (framework) =>
          framework.dev({
            root,
            port: devOptions?.port,
            host: devOptions?.host,
          }),
        );
      },
    };
  });
