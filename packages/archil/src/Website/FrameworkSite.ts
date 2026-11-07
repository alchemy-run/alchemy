import { AlchemyContext } from "alchemy/AlchemyContext";
import type { MemoOptions } from "alchemy/Command/Memo";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { initialCwd } from "alchemy/Util/Node";
import {
  staticConfigFromAssets,
  type WebsiteAssetsProps,
  type WebsiteNotFoundHandling,
} from "alchemy/Website/assets";
import { packSiteExtraFiles } from "alchemy/Website/packExtraFiles";
import { Server as FrameworkServer, type ServerDevProps } from "alchemy/Website/Server";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { Sandbox, type SandboxProps } from "../Sandbox.ts";

// Outputs stand in for plain prop values here: the engine resolves them
// before reconcile, but Output<T> isn't assignable to T in the props type,
// so those props are cast.

/** Port every Archil website listens on. */
export const DEFAULT_WEBSITE_PORT = 3000;

export type { ServerDevProps, WebsiteAssetsProps, WebsiteNotFoundHandling };
export { staticConfigFromAssets };

/** Props shared by every Archil framework website composite. */
export interface FrameworkSiteProps {
  /**
   * Project root directory (the directory containing `package.json`).
   * @default "."
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /** Options for the local dev server that runs this site under `alchemy dev`. */
  dev?: ServerDevProps;
  /**
   * Process environment for the site's program (and the local framework
   * dev server). Accepts `Output`s (e.g. `VITE_API_URL: api.url`).
   */
  env?: Record<string, string | Redacted.Redacted<string> | Output.Output<string | undefined>>;
  /** Static-asset routing (`notFoundHandling`, `htmlHandling`). */
  assets?: WebsiteAssetsProps;
  /**
   * The site's own sandbox: size, image, timeouts, disks and network
   * policy. The site is its program.
   * @default 1 vCPU, 2 GiB, `node:24-bookworm`
   */
  sandbox?: WebsiteSandboxOptions;
}

/** Options for the sandbox a website runs in (everything but its program). */
export type WebsiteSandboxOptions = Omit<
  SandboxProps,
  "main" | "handler" | "port" | "build" | "extraFiles" | "isExternal" | "env"
>;

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** Node deploy-target module specifier. */
  target: string;
  /**
   * Framework-specific build options forwarded to the integration (e.g.
   * `{ kit }`, `{ nuxt }`, `{ astro }`). Must be JSON-serializable.
   */
  options?: Record<string, unknown> | undefined;
  /**
   * Assets-only mode: no server modules (or every page prerendered). The
   * composite generates a static-file server as `main`.
   */
  static?:
    | {
        spa?: boolean | undefined;
        errorPage?: string | undefined;
        htmlHandling?: "none" | "drop-trailing-slash" | undefined;
      }
    | undefined;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
  /** Skip uploading `clientDirectory` at `dist/`. Next.js serves `.next` from the root. */
  skipClientAssets?: boolean | undefined;
  /**
   * Packages to `npm install` next to the program instead of bundling
   * (Next.js needs `next` / `react` / `react-dom`).
   */
  install?: string[] | undefined;
}

export interface Website {
  /** Local framework URL under `alchemy dev`, or the sandbox's `https://` URL. */
  readonly url: string | Output.Output<string | undefined> | undefined;
  /** The sandbox the site runs in. `undefined` during `alchemy dev`. */
  readonly sandbox: Sandbox | undefined;
}

export class FrameworkSiteError extends Data.TaggedError("Archil.Website.FrameworkSiteError")<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const unwrapEnv = (
  env:
    | Record<string, string | Redacted.Redacted<string> | Output.Output<string | undefined>>
    | undefined,
): Record<string, string | Output.Output<string | undefined>> | undefined => {
  if (env === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );
};

/**
 * Shared implementation behind the Archil framework website composites:
 * build through the Node deploy target, then run it as the program of its
 * own `Archil.Sandbox`.
 *
 * During `alchemy dev` the site is the framework's own dev server and no
 * cloud resources are declared; `Alchemy.remote()` opts back into the
 * live sandbox.
 */
const runFrameworkSite = Effect.fn("Archil.Website.FrameworkSite")(function* (
  _id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  const isLocal = ctx.dev && remoted !== true;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const port = DEFAULT_WEBSITE_PORT;

  if (config.static?.spa && config.static.errorPage) {
    return yield* Effect.die(
      `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page (200); "errorPage" answers them with a real 404.`,
    );
  }

  const build = yield* FrameworkServer("Build", {
    framework: config.framework,
    target: config.target,
    root: props.rootDir,
    env: unwrapEnv(props.env),
    options: config.options,
    memo: props.memo,
    dev: props.dev,
  });

  if (isLocal) {
    return { url: build.url, sandbox: undefined } satisfies Website;
  }

  // The build runs at apply time, so its attributes are Outputs here:
  // derive every deploy input lazily and let the engine resolve them once
  // the build has produced real paths.
  const buildOut = Output.mapEffect(
    ([serverEntry, distDir]: [string | undefined, string | undefined]) =>
      Effect.gen(function* () {
        if (serverEntry === undefined || distDir === undefined) {
          return yield* Effect.die(
            new FrameworkSiteError({
              framework: config.framework,
              message: `The ${config.name} build produced no Node serve entry (serverModules[0]). The Node deploy target should write serve-node.mjs.`,
            }),
          );
        }
        const main = path.resolve(initialCwd, serverEntry);
        if (!(yield* fs.exists(main).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* Effect.die(
            new FrameworkSiteError({
              framework: config.framework,
              message: `The ${config.name} build produced no server entry at ${main}`,
            }),
          );
        }
        return { distDir: path.resolve(initialCwd, distDir), main };
      }),
  )(
    Output.all(
      build.serverEntry as unknown as Output.Output<string | undefined>,
      build.distDir as unknown as Output.Output<string | undefined>,
    ) as unknown as Output.Output<[string | undefined, string | undefined]>,
  );
  const main = Output.map(buildOut, (out) => out.main);

  const extraFiles = Output.mapEffect((out: { distDir: string; main: string }) =>
    packSiteExtraFiles(out.distDir, config.skipClientAssets === true ? "next" : "client").pipe(
      Effect.map((files) =>
        // Always a list, so the sandbox uploads `main` as a complete program.
        (files ?? []).map((file) => ({ source: file.source, destination: file.dest })),
      ),
    ),
  )(buildOut);

  const sandbox = yield* Sandbox("Sandbox", {
    ...props.sandbox,
    main: main as unknown as string,
    extraFiles: extraFiles as unknown as Array<{ source: string; destination: string }>,
    port,
    env: unwrapEnv(props.env) as Record<string, string> | undefined,
    isExternal: true,
    build:
      config.install !== undefined && config.install.length > 0
        ? { install: config.install }
        : undefined,
  });

  return { url: sandbox.url, sandbox } satisfies Website;
});

/**
 * Composite-level tagged errors (`FrameworkSiteError`, filesystem) are
 * defects — `Alchemy.Stack` only admits `ConfigError` on the user effect.
 */
export const makeFrameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => runFrameworkSite(id, props, config).pipe(Effect.orDie);
