import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Command from "../../Command/index.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import {
  DEFAULT_WEBSITE_PORT,
  deployContainerSite,
  unwrapEnv,
  type FrameworkSiteProps,
  type Website,
} from "./FrameworkSite.ts";
import { loadFrontendCore } from "../../Website/FrontendCore.ts";

export interface StaticSiteProps extends Pick<
  FrameworkSiteProps,
  | "domain"
  | "tags"
  | "env"
  | "resourceGroup"
  | "location"
  | "environment"
  | "registry"
> {
  /**
   * Shell command that produces the site (e.g. `hugo --minify`).
   */
  command: string;
  /**
   * Directory the command writes, relative to {@link cwd}.
   */
  outdir: string;
  /**
   * Working directory for {@link command}.
   * @default process.cwd()
   */
  cwd?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * Answer misses with the index page (200) instead of a 404 so
   * client-side routes deep-link correctly. Mutually exclusive with
   * {@link errorPage}.
   */
  spa?: boolean;
  /**
   * Serve this page with a real `404` status for requests that match no
   * file. Mutually exclusive with {@link spa}.
   */
  errorPage?: string;
  /**
   * Local dev configuration. When `alchemy dev` runs, the build command
   * is skipped and `command` is spawned as a long-lived child. Without
   * `dev`, the site is still built and served locally (no cloud Service).
   */
  dev?: {
    /**
     * Shell command to run as the local dev server (e.g. `npm run dev`).
     */
    command: string;
    /**
     * Working directory for {@link command}. Defaults to
     * {@link StaticSiteProps.cwd}.
     */
    cwd?: string;
    /**
     * Environment variables for {@link command}, merged on top of
     * `process.env`.
     */
    env?: Record<string, string | Redacted.Redacted<string>>;
    /**
     * Override for the `url` output if alchemy fails to detect it from
     * stdout of the dev command.
     */
    url?: string;
  };
}

/**
 * A Azure Service that serves static assets built by a shell command.
 *
 * `StaticSite` runs a build command (e.g. `npm run build`), packs the
 * output directory into the unit archive, and deploys a tiny static-file
 * server (`GET` assets, `/health`, optional SPA / 404-page). Use this
 * when your site has its own build step — Hugo, Zola, Eleventy, or any
 * custom pipeline.
 *
 * For Vite-based projects, prefer {@link Vite | Azure.Website.Vite}.
 *
 * `Dev` and `Build` carry constant logical ids, so they are namespaced
 * under `id`. The Service stays in the caller's namespace (same as
 * Cloudflare.Website.StaticSite).
 *
 *
 * ### Basic Usage
 * **Example:** Deploying a Hugo site
 * ```typescript
 * const site = yield* Azure.Website.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 * });
 * ```
 *
 * **Example:** SPA-style routing
 * ```typescript
 * const site = yield* Azure.Website.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   spa: true,
 * });
 * ```
 *
 * ### Building from a Subdirectory
 * **Example:** Building a frontend in a monorepo
 * ```typescript
 * const site = yield* Azure.Website.StaticSite("Web", {
 *   cwd: "apps/web",
 *   command: "npm run build",
 *   outdir: "dist",
 * });
 * ```
 *
 * ### Local Development
 * **Example:** External Dev Server
 * ```typescript
 * const site = yield* Azure.Website.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   dev: { command: "npm run dev" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const StaticSite = (id: string, props: StaticSiteProps) =>
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    const isLocal = ctx.dev && remoted !== true;
    const port = DEFAULT_WEBSITE_PORT;

    if (props.spa && props.errorPage) {
      return yield* Effect.die(
        `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page (200); "errorPage" answers them with a real 404.`,
      );
    }

    if (isLocal && props.dev) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd: props.dev.cwd ?? props.cwd,
        env: props.dev.env ?? props.env,
      }).pipe(Namespace.push(id));
      const url = Output.map(
        (detected: string | undefined) => detected ?? props.dev?.url,
      )(dev.url);
      return {
        url,
        resourceGroup: undefined,
        environment: undefined,
        registry: undefined,
        app: undefined,
      } satisfies Website;
    }

    const build = yield* Command.Build("Build", {
      command: props.command,
      cwd: props.cwd,
      memo: props.memo,
      outdir: props.outdir,
      env: props.env,
    }).pipe(Namespace.push(id));

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = path.resolve(initialCwd, props.cwd ?? ".");
    const outdir = path.resolve(cwd, props.outdir);
    const {
      NODE_SERVE_ENTRY_FILE_NAME,
      relativeClientDirExpression,
      writeNodeServeEntry,
    } = yield* loadFrontendCore;
    const servePath = path.join(
      path.dirname(outdir),
      NODE_SERVE_ENTRY_FILE_NAME,
    );
    yield* writeNodeServeEntry({
      output: {
        clientDirectory: outdir,
        serverModules: [],
        externalWorkspaces: new Set<string>(),
      },
      servePath,
      serveModuleName: NODE_SERVE_ENTRY_FILE_NAME,
      clientDirExpression: relativeClientDirExpression(servePath, outdir),
      notFoundHandling:
        props.errorPage !== undefined
          ? "404-page"
          : props.spa === true
            ? "spa"
            : "none",
      printUrl: isLocal,
      defaultPort: port,
      platform: "node",
    });

    if (isLocal) {
      const bun = yield* Effect.sync(() => process.execPath);
      const dev = yield* Command.Dev("Dev", {
        command: `${bun} ${servePath}`,
        cwd: path.dirname(servePath),
        env: {
          ...unwrapEnv(props.env),
          ALCHEMY_BUILD_HASH: build.hash.output as unknown as string,
          PORT: "0",
          HOST: "127.0.0.1",
        },
      }).pipe(Namespace.push(id));
      return {
        url: dev.url,
        resourceGroup: undefined,
        environment: undefined,
        registry: undefined,
        app: undefined,
      } satisfies Website;
    }

    const site = yield* deployContainerSite({
      site: {
        domain: props.domain,
        tags: props.tags,
        env: props.env,
        resourceGroup: props.resourceGroup,
        location: props.location,
        environment: props.environment,
        registry: props.registry,
      },
      main: servePath,
      extraFiles: [{ source: outdir, dest: path.basename(outdir) }],
    }).pipe(Namespace.push(id));
    return {
      ...site,
    } satisfies Website;
  }).pipe(Effect.orDie);
