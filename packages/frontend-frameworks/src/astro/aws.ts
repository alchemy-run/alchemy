/**
 * `@alchemy.run/frontend-frameworks/astro/aws` — the AWS Lambda deploy target
 * for the Astro integration.
 *
 * Astro's AWS story is a plain Node SSR bundle behind a Lambda Function
 * URL: the adapter integration pins this package's `aws-server` entrypoint
 * (which wraps `App.render` with the `@alchemy.run/frontend-frameworks/aws-lambda`
 * handler adapter) as the build's server entry, and forces the server build
 * to be **self-contained** (`vite.ssr.noExternal: true`) so `dist/server`
 * can ship to Lambda as-is (`bundle: false`). What this target owns:
 *
 * - **`integration`** — the adapter integration: registers itself via
 *   `setAdapter` at `astro:config:done` (rejecting a user-declared adapter
 *   with an actionable error), pins the `aws-server` entrypoint, and
 *   configures the server build for self-containment.
 * - **`finish`** — a fully-static build (`output: "static"`: every route
 *   prerendered) deploys ASSETS-ONLY: `serverModules` is dropped so the
 *   composite skips the Lambda entirely.
 * - **`selectServerEntry`** — pins the adapter's entry chunk as
 *   `serverModules[0]` (astro's page modules are rolldown inputs in the
 *   same environment, so the entry environment emits many entry chunks).
 * - **`bundle`** — Node resolve conditions and the `@aws-sdk/` externals
 *   (the Lambda Node.js runtime ships SDK v3) for callers that post-process
 *   server code.
 *
 * No `devPlatform`: `dev` runs Astro's own Node dev server, which is
 * already the AWS Lambda programming model (plain Node).
 */
import type { AstroInlineConfig, AstroIntegration } from "astro";
import * as Effect from "effect/Effect";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  DeployTargetError,
  makeDeployTarget,
  type ServerEntryChunk,
} from "../core/index.ts";
import { fileURLToPath } from "node:url";
import type * as vite from "vite";
import { make } from "./Astro.ts";
import { createEffectFetchablePlugin } from "./fetchable-plugin.ts";
import type { AstroTarget, AstroTargetBuildContext } from "./Target.ts";

/**
 * The importable specifier of this package's AWS Lambda server entrypoint —
 * the module the adapter pins as `serverEntrypoint`. It exports the Lambda
 * `handler` (streaming by default).
 */
export const SERVER_ENTRYPOINT =
  "@alchemy.run/frontend-frameworks/astro/entrypoints/aws-server";

/** AWS-specific target configuration. */
export interface AstroAwsConfig {
  /**
   * Whether the emitted Lambda handler streams its response
   * (`awslambda.streamifyResponse`, requires a Function URL with
   * `invokeMode: RESPONSE_STREAM`). With `false` — or whenever the
   * `awslambda` global is absent — the buffered handler answers
   * APIGW/Function-URL events with a complete payload-v2 response object.
   * @default true
   */
  readonly streaming?: boolean | undefined;
  /**
   * Effectful-Website single-handler delivery (Serve/DESIGN.md, set by
   * `AWS.Website.Astro` when an Effect program is passed): the effect
   * program module (`main` — `props.main`, an absolute path or `file://`
   * URL). HTTP delivery is EXPLICIT MOUNTS ONLY — the user's fetch file
   * (`src/fetch.ts`) mounts `site.fetch(request) ?? astro(...)` and rides
   * Astro's own pipeline, prod and dev. The adapter integration swaps the
   * server entrypoint for a generated wrapper that grafts Astro's fetch
   * verbatim into `makeFrameworkFunctionHandler`, so the program's
   * non-fetch listeners (queue consumers, schedules) dispatch on the SAME
   * Lambda. The build-time prerenderer keeps astro's default fetchable,
   * so prerendering never touches the effect module graph.
   */
  readonly effect?:
    | {
        readonly main: string;
      }
    | undefined;
}

/**
 * The virtual server-entrypoint id pinned as the adapter's
 * `serverEntrypoint` on effectful sites — resolved and loaded by
 * {@link createAwsEffectEntryPlugin} inside the `ssr` environment.
 */
export const EFFECT_SERVER_ENTRYPOINT =
  "virtual:alchemy:astro-aws-effect-server";
const RESOLVED_EFFECT_SERVER_ENTRYPOINT = `\0${EFFECT_SERVER_ENTRYPOINT}`;

/** Normalize a path or `file://` URL to a `/`-separated absolute path. */
const toPath = (value: string): string =>
  (value.startsWith("file:") ? fileURLToPath(value) : value).replaceAll(
    "\\",
    "/",
  );

/**
 * The generated effect server-entrypoint source (exported for unit tests):
 * ADDITIVE-ONLY (Serve/DESIGN.md) — Astro's fetch (the vendored
 * `aws-server` entrypoint's `fetchHandler`, whose `App.render` runs the
 * user's `src/fetch.ts` mount through the fetchable seam) serves ALL HTTP
 * verbatim; `makeFrameworkFunctionHandler` adds the program's non-fetch
 * listener dispatch on the same function, inside the one
 * `awslambda.streamifyResponse` wrap.
 */
export const makeAwsEffectEntrySource = (options: {
  /** Resolved id of the real vendored `aws-server` entry module. */
  readonly entryId: string;
  readonly mainPath: string;
}): string =>
  [
    `// Generated by alchemy — Astro AWS single-handler entry (additive):`,
    `// Astro's fetch — with the user's src/fetch.ts mount inside — serves`,
    `// ALL HTTP verbatim; the wrapper adds the program's non-fetch listener`,
    `// dispatch (queue consumers, schedules) on the same function.`,
    `globalThis.__ALCHEMY_RUNTIME__ = true;`,
    `import { fetchHandler as __astroFetch } from ${JSON.stringify(options.entryId)};`,
    `import { makeFrameworkFunctionHandler } from "alchemy/AWS/Serve";`,
    `import Site from ${JSON.stringify(options.mainPath)};`,
    `export const handler = await makeFrameworkFunctionHandler({`,
    `  site: Site,`,
    `  fetch: __astroFetch,`,
    `});`,
    ``,
  ].join("\n");

/**
 * The effect entry plugin: resolves the virtual
 * {@link EFFECT_SERVER_ENTRYPOINT} (pinned as the adapter's
 * `serverEntrypoint`) to the generated wrapper inside the `ssr`
 * environment. The prerender environment never sees the virtual id (the
 * adapter's prerender pipeline renders through astro's own entry).
 */
export const createAwsEffectEntryPlugin = (options: {
  readonly mainPath: string;
}): vite.Plugin => {
  const mainPath = toPath(options.mainPath);
  return {
    name: "@alchemy.run/frontend-frameworks/astro:aws-effect-entry",
    enforce: "pre",
    resolveId: {
      filter: {
        id: [
          new RegExp(`^${EFFECT_SERVER_ENTRYPOINT.replace(/:/g, "\\:")}$`),
          // oxlint-disable-next-line no-control-regex
          new RegExp(
            `^${RESOLVED_EFFECT_SERVER_ENTRYPOINT.replace("\0", "\\0").replace(/:/g, "\\:")}$`,
          ),
        ],
      },
      handler() {
        return RESOLVED_EFFECT_SERVER_ENTRYPOINT;
      },
    },
    load: {
      filter: {
        id: new RegExp(
          `^${RESOLVED_EFFECT_SERVER_ENTRYPOINT.replace("\0", "\\0").replace(/:/g, "\\:")}$`,
        ),
      },
      handler() {
        // The wrapper reaches the REAL vendored aws-server entry by
        // concrete file path, resolved with node semantics from this
        // package (the specifier is our own subpath export).
        const entryId = toPath(import.meta.resolve(SERVER_ENTRYPOINT));
        return { code: makeAwsEffectEntrySource({ entryId, mainPath }) };
      },
    },
  };
};

export interface AstroAwsTarget extends AstroTarget<AstroAwsConfig> {}

/** Options for {@link distilledAws} (the adapter integration). */
export interface DistilledAwsOptions {
  /** See {@link AstroAwsConfig.streaming}. @default true */
  readonly streaming?: boolean | undefined;
  /** See {@link AstroAwsConfig.effect}. */
  readonly effect?: AstroAwsConfig["effect"];
  /**
   * Reports the resolved build output mode (`astro:config:done`'s
   * `buildOutput`): `"static"` when every route is prerendered, `"server"`
   * when any route renders on demand. The target's `finish` pass uses it to
   * strip `serverModules` from a fully-static build so the deploy is
   * assets-only (no Lambda).
   * @internal
   */
  readonly onBuildOutput?:
    | ((buildOutput: "static" | "server") => void)
    | undefined;
  /**
   * Reports the resolved server-entry file name (`config.build.serverEntry`,
   * `entry.mjs` by default) so the entry chunk can be pinned as
   * `serverModules[0]`.
   * @internal
   */
  readonly onServerEntryName?: ((name: string) => void) | undefined;
}

/**
 * The AWS Lambda adapter integration for Astro. Injected via
 * `integrations` (after the user's) rather than `adapter`: it registers
 * itself as the adapter at `astro:config:done`, where it also rejects a
 * user-declared adapter with an actionable error.
 */
export const distilledAws = (
  options: DistilledAwsOptions = {},
): AstroIntegration => {
  // Whether WE satisfied `config.adapter`. The user's astro.config.* loads
  // natively and this integration is injected via `integrations`, but
  // astro's build refuses server output unless `config.adapter` is set — so
  // `astro:config:setup` injects a hookless marker when the config declares
  // no adapter (the real adapter registration is `setAdapter` at
  // `astro:config:done`). When the flag is still false at
  // `astro:config:done`, the user declared their own adapter — a conflict.
  let injectedAdapterMarker = false;
  return {
    name: "@alchemy.run/frontend-frameworks/astro-aws",
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        if (config.adapter === undefined) {
          injectedAdapterMarker = true;
          updateConfig({
            adapter: {
              name: "@alchemy.run/frontend-frameworks/astro-aws",
              hooks: {},
            },
          });
        }
        // Effectful-Website single-handler delivery (Serve/DESIGN.md):
        // HTTP is the user's src/fetch.ts mount, riding astro's own
        // fetchable seam. The config plugin stamps the runtime define and
        // dep-optimizer excludes for the mount's alchemy graph (ssr +
        // astro dev environments); the entry plugin swaps the server
        // entrypoint for the generated `makeFrameworkFunctionHandler`
        // wrapper so non-fetch listeners dispatch on the same Lambda.
        if (options.effect !== undefined) {
          updateConfig({
            vite: {
              plugins: [
                createEffectFetchablePlugin({ platform: "node" }),
                createAwsEffectEntryPlugin({
                  mainPath: options.effect.main,
                }),
              ],
            },
          });
        }
      },
      "astro:config:done": ({ setAdapter, config, buildOutput }) => {
        if (config.adapter !== undefined && !injectedAdapterMarker) {
          throw new Error(
            `@alchemy.run/frontend-frameworks/astro/aws: the Astro config declares the adapter "${config.adapter.name}", ` +
              "but the deploy target already provides the AWS Lambda adapter. " +
              "Remove `adapter` from your astro.config file — user integrations " +
              "(react, mdx, tailwind, ...) are honored, and the adapter is injected by the toolchain.",
          );
        }
        options.onBuildOutput?.(buildOutput);
        options.onServerEntryName?.(config.build.serverEntry);
        setAdapter({
          name: "@alchemy.run/frontend-frameworks/astro-aws",
          entrypointResolution: "auto",
          // Effectful sites pin the generated single-handler wrapper (the
          // entry plugin resolves the virtual id inside the ssr build).
          serverEntrypoint:
            options.effect !== undefined
              ? EFFECT_SERVER_ENTRYPOINT
              : SERVER_ENTRYPOINT,
          adapterFeatures: {
            buildOutput,
            middlewareMode: "classic",
            preserveBuildClientDir: true,
            preserveBuildServerDir: true,
          },
          supportedAstroFeatures: {
            serverOutput: "stable",
            hybridOutput: "stable",
            staticOutput: "stable",
            i18nDomains: "experimental",
            envGetSecret: "stable",
            sharpImageService: {
              support: "limited",
              message:
                "sharp is not shipped with the Lambda server bundle; install it as a project dependency to optimize images at build time",
            },
          },
        });
      },
      "astro:build:setup": ({ vite: viteConfig, target }) => {
        if (target === "server") {
          // Self-contained dist/server: Lambda ships the directory as-is
          // (`bundle: false`), so every server dependency must be bundled
          // into the emitted chunks. Node builtins stay external
          // automatically; sharp is a native module that can never bundle,
          // and the Lambda Node.js runtime provides `@aws-sdk/*` v3.
          viteConfig.ssr ||= {};
          viteConfig.ssr.noExternal = true;
          viteConfig.build ||= {};
          const build = viteConfig.build as Record<string, any>;
          build.rolldownOptions ||= {};
          build.rolldownOptions.external = ["sharp", /^@aws-sdk\//];
          viteConfig.define = {
            __ALCHEMY_ASTRO_AWS_STREAMING__: JSON.stringify(
              options.streaming ?? true,
            ),
            ...viteConfig.define,
          };
        }
      },
    },
  };
};

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "aws", message, cause });

/**
 * The adapter-driven target — the shape the framework's regular
 * build/finish pipeline consumes. Used directly in the build child (where
 * `cwd === root` holds); {@link target} wraps it with the wholesale
 * `build` hook that spawns the child.
 */
const makeAwsAdapterTarget = (config: AstroAwsConfig = {}): AstroAwsTarget => {
  // The resolved build output mode from `astro:config:done`: `"static"`
  // means every route is prerendered, so the deploy must be assets-only.
  let buildOutput: "static" | "server" | undefined;
  // The resolved server-entry file name (`entry.mjs` by default).
  let serverEntryName: string | undefined;
  return makeDeployTarget({
    platform: "aws",
    config,
    bundle: {
      conditions: ["node", "import", "module"],
      external: ["@aws-sdk/"],
    },
    integration: () =>
      distilledAws({
        streaming: config.streaming,
        effect: config.effect,
        onBuildOutput: (mode) => {
          buildOutput = mode;
        },
        onServerEntryName: (name) => {
          serverEntryName = name;
        },
      }),
    // Astro's page modules are rolldown inputs of the `ssr` environment, so
    // it emits many entry chunks; pin the adapter's server entry (renamed to
    // `config.build.serverEntry` by astro; facade = the aws-server module,
    // or the generated effect wrapper on effectful sites).
    selectServerEntry: (chunk: ServerEntryChunk): boolean =>
      chunk.fileName === (serverEntryName ?? "entry.mjs") ||
      (chunk.facadeModuleId !== null &&
        (/\/entrypoints\/aws-server\.(?:ts|js|mjs)$/.test(
          chunk.facadeModuleId.replaceAll("\\", "/"),
        ) ||
          chunk.facadeModuleId.includes(
            "virtual:alchemy:astro-aws-effect-server",
          ))),
    // A fully-static build deploys ASSETS-ONLY: the SSR entry astro bundled
    // for prerendering is dropped from the output and the client directory
    // carries all prerendered HTML, `404.html` included.
    finish: (output) =>
      Effect.succeed(
        buildOutput === "static"
          ? { ...output, serverModules: undefined }
          : output,
      ),
  });
};

/**
 * The natively-loaded `astro.config.*` executes user plugins/integrations
 * that may read the cwd, mutate `process.env`, or `process.chdir` — none of
 * which may touch the engine process (many deploys share one event loop).
 * This target's wholesale `build` therefore runs the framework in a
 * disposable child process whose working directory IS the project root (see
 * `core/BuildChild.ts`). The shared `core/BuildChildRunner` entry imports
 * this module in the child and calls the exported {@link buildInChild}.
 */
export interface AstroAwsBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: AstroAwsConfig;
  /**
   * The inline Astro overlay the framework was constructed with
   * (`AstroFrameworkOptions.astro`, carried through the build context).
   * Only JSON-serializable fields cross the process boundary.
   */
  readonly astro: AstroInlineConfig | undefined;
}

export const buildInChild = (config: AstroAwsBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      // The adapter-only target: no wholesale `build` hook, so the child
      // runs the regular astro build + finish pipeline (no recursion).
      target: makeAwsAdapterTarget(config.config),
      astro: config.astro,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Build the AWS Lambda {@link AstroTarget}. See the module doc for the
 * seams.
 */
export const target = (config: AstroAwsConfig = {}): AstroAwsTarget => ({
  ...makeAwsAdapterTarget(config),
  build: (context: AstroTargetBuildContext) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      framework: "astro",
      config: {
        rootDir: context.root,
        config,
        astro: context.astro,
      } satisfies AstroAwsBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export default target;
