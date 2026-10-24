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
import {
  deployStaticSite,
  localWebsite,
  unwrapEnv,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";

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
   * correctly. The storage endpoint sends it with a `404` status; set
   * `frontDoor` to answer with `200`. Mutually exclusive with
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
   * `dev`, the site is still built and served locally (no Azure resources).
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
 * A static site built by a shell command and served from the static
 * website endpoint of an Azure Storage account.
 *
 * `StaticSite` runs a build command (e.g. `npm run build`) and uploads the
 * output directory to the account's `$web` container. Unchanged files are
 * skipped and removed files are deleted. No Docker image and no server are
 * involved. Use this when your site has its own build step — Hugo, Zola,
 * Eleventy, or any custom pipeline.
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
 * **Example:** SPA deep links with a `200` status
 * ```typescript
 * const site = yield* Azure.Website.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   spa: true,
 *   frontDoor: true,
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
          ALCHEMY_BUILD_HASH: build.hash.output as unknown as string,
          PORT: "0",
          HOST: "127.0.0.1",
        },
      }).pipe(Namespace.push(id));
      return localWebsite(dev.url);
    }

    // The build output is the site: publish it as-is. `build.outdir` orders
    // the upload after the build.
    const published = Output.map((dir: string) => path.resolve(initialCwd, dir))(
      build.outdir as unknown as Output.Output<string>,
    );
    return yield* deployStaticSite({
      site: props,
      path: published as unknown as string,
      spa: props.spa === true,
      errorPage: props.errorPage,
    }).pipe(Namespace.push(id));
  }).pipe(Effect.orDie);
