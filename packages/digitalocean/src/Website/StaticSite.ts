import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Command from "alchemy/Command";
import type { MemoOptions } from "alchemy/Command/Memo";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { initialCwd } from "alchemy/Util/Node";
import { loadFrontendCore } from "alchemy/Website/FrontendCore";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { App } from "../App.ts";
import {
  appProps,
  DEFAULT_WEBSITE_PORT,
  unwrapEnv,
  type FrameworkSiteProps,
  type Website,
} from "./FrameworkSite.ts";

export interface StaticSiteProps extends Pick<
  FrameworkSiteProps,
  "env" | "region" | "instanceSizeSlug" | "instanceCount" | "registry"
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
   * `dev`, the site is still built and served locally (no App).
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
 * A DigitalOcean App that serves static files built by a shell command
 * (Hugo, Jekyll, Eleventy, a hand-written `dist/`). The output is baked
 * into the App's image with a small static-file server.
 *
 * For Vite-based projects, prefer {@link Vite | DigitalOcean.Website.Vite}.
 *
 * ### Creating Static Sites
 * **Example:** A Hugo blog
 * ```typescript
 * const site = yield* DigitalOcean.Website.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 * });
 * ```
 *
 * **Example:** A single-page app
 * ```typescript
 * const site = yield* DigitalOcean.Website.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   spa: true,
 * });
 * ```
 *
 * @resource
 * @product App Platform
 * @category Website
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
      const url = Output.map((detected: string | undefined) => detected ?? props.dev?.url)(dev.url);
      return { url, app: undefined } satisfies Website;
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
    const { NODE_SERVE_ENTRY_FILE_NAME, relativeClientDirExpression, writeNodeServeEntry } =
      yield* loadFrontendCore;
    const servePath = path.join(path.dirname(outdir), NODE_SERVE_ENTRY_FILE_NAME);
    yield* writeNodeServeEntry({
      output: { clientDirectory: outdir, serverModules: [], externalWorkspaces: new Set<string>() },
      servePath,
      serveModuleName: NODE_SERVE_ENTRY_FILE_NAME,
      clientDirExpression: relativeClientDirExpression(servePath, outdir),
      notFoundHandling:
        props.errorPage !== undefined ? "404-page" : props.spa === true ? "spa" : "none",
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
      return { url: dev.url, app: undefined } satisfies Website;
    }

    const app = yield* App(id, {
      ...appProps(props, port),
      main: servePath,
      extraFiles: [{ source: outdir, dest: path.basename(outdir) }],
      env: { ...unwrapEnv(props.env), PORT: String(port) },
    });
    return { url: app.url, app } satisfies Website;
  }).pipe(Effect.orDie);
