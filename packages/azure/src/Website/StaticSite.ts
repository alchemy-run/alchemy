import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Command from "alchemy/Command";
import type { MemoOptions } from "alchemy/Command/Memo";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { initialCwd } from "alchemy/Util/Node";
import { loadFrontendCore } from "alchemy/Website/FrontendCore";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { deploySite, localWebsite, unwrapEnv, type FrameworkSiteProps } from "./FrameworkSite.ts";

export interface StaticSiteProps extends Pick<
  FrameworkSiteProps,
  "tags" | "env" | "resourceGroup" | "location" | "storageAccount" | "frontDoor"
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
   * Answer misses with the index page so client-side routes deep-link
   * correctly. Front Door answers them with a `200` status; with
   * `frontDoor: false` the storage endpoint sends a `404` status. Mutually
   * exclusive with {@link errorPage}.
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
   * `dev`, the site is still built and a local static server (from
   * `@alchemy.run/frontend-frameworks`, which must be installed) serves
   * {@link outdir}. Neither path creates Azure resources.
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
 * A static site built by a shell command, stored in the static website
 * endpoint of an Azure Storage account, and served through Azure Front
 * Door.
 *
 * `StaticSite` runs a build command (e.g. `npm run build`) and uploads the
 * output directory to the account's `$web` container with a
 * `Cache-Control` per file (HTML is never cached, other files are
 * immutable). Unchanged files are skipped, removed files are deleted, and
 * the paths of replaced and deleted files are purged from Front Door. No
 * Docker image and no server are involved. Use this when your site has its
 * own build step — Hugo, Zola, Eleventy, or any custom pipeline.
 *
 * Front Door Standard is on by default and costs a monthly base fee per
 * profile: pass `frontDoor: { profile }` to share one profile across
 * sites, or `frontDoor: false` to serve straight from the storage
 * endpoint. A new Front Door endpoint takes 10-20 minutes to serve
 * everywhere.
 *
 * For Vite-based projects, prefer {@link Vite | Azure.Website.Vite}.
 *
 * Every resource is namespaced under `id`.
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
 * **Example:** Multi-page site with a real 404 page
 * ```typescript
 * const docs = yield* Azure.Website.StaticSite("Docs", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   errorPage: "404.html",
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
 * ### Front Door
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const docs = yield* Azure.Website.StaticSite("Docs", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * **Example:** Serve from the storage endpoint without Front Door
 * ```typescript
 * const site = yield* Azure.Website.StaticSite("Preview", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   frontDoor: false,
 * });
 * // site.url → "https://{account}.z13.web.core.windows.net"
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

    if (props.spa && props.errorPage) {
      return yield* Effect.die(
        `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page; "errorPage" answers them with a real 404.`,
      );
    }

    if (isLocal && props.dev) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd: props.dev.cwd ?? props.cwd,
        env: props.dev.env ?? props.env,
      }).pipe(Namespace.push(id));
      return localWebsite(
        Output.map((detected: string | undefined) => detected ?? props.dev?.url)(dev.url),
      );
    }

    const build = yield* Command.Build("Build", {
      command: props.command,
      cwd: props.cwd,
      memo: props.memo,
      outdir: props.outdir,
      env: props.env,
    }).pipe(Namespace.push(id));

    const path = yield* Path.Path;
    const cwd = path.resolve(initialCwd, props.cwd ?? ".");
    const outdir = path.resolve(cwd, props.outdir);

    if (isLocal) {
      // Serve the built directory with the shared Node static server.
      const fs = yield* FileSystem.FileSystem;
      const { NODE_SERVE_ENTRY_FILE_NAME, relativeClientDirExpression, writeNodeServeEntry } =
        yield* loadFrontendCore;
      const servePath = path.join(path.dirname(outdir), NODE_SERVE_ENTRY_FILE_NAME);
      yield* fs.makeDirectory(path.dirname(servePath), { recursive: true });
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
          props.errorPage !== undefined ? "404-page" : props.spa === true ? "spa" : "none",
        printUrl: true,
        platform: "node",
      });
      const bun = yield* Effect.sync(() => process.execPath);
      const dev = yield* Command.Dev("Dev", {
        command: `${bun} ${servePath}`,
        cwd: path.dirname(servePath),
        env: {
          ...unwrapEnv(props.env),
          // Restarts the server when the build output changes.
          ALCHEMY_BUILD_HASH: Output.map(build.hash.output, (hash) => hash ?? ""),
          PORT: "0",
          HOST: "127.0.0.1",
        },
      }).pipe(Namespace.push(id));
      return localWebsite(dev.url);
    }

    // The build output is the site: publish it as-is. `build.outdir` orders
    // the upload after the build.
    const published = Output.map(build.outdir, (dir) => path.resolve(initialCwd, dir));
    return yield* deploySite({
      site: props,
      framework: "StaticSite",
      clientDir: published,
      serverEntry: undefined,
      assetPatterns: undefined,
      spa: props.spa === true,
      errorPage: props.errorPage,
    }).pipe(Namespace.push(id));
  }).pipe(Effect.orDie);
