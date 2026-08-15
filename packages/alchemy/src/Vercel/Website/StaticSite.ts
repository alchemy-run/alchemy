import * as Effect from "effect/Effect";
import * as Command from "../../Command/index.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { effectClass } from "../../Util/effect.ts";
import type { BuildOutputRoute } from "../Deploy/BuildOutput.ts";
import { Function, type FunctionProps } from "../Functions/Function.ts";
import type { Providers } from "../Providers.ts";
import { resolveWebsiteProps, serializeBuildEnv } from "./internal.ts";

export interface StaticSiteProps extends Omit<
  FunctionProps,
  | "main"
  | "script"
  | "prebuilt"
  | "source"
  | "build"
  | "runtime"
  | "resources"
  | "regions"
> {
  /**
   * Shell command that produces {@link outdir} (e.g. `npm run build`,
   * `hugo --minify`, or a `./build.sh`).
   */
  command: string;
  /**
   * Working directory for {@link command}. Defaults to the process working
   * directory.
   */
  cwd?: string;
  /**
   * The output directory produced by the build, relative to {@link cwd}.
   * Every file under it deploys as a static asset.
   * @example "dist"
   */
  outdir: string;
  /**
   * Controls which files are hashed to decide whether the build should
   * re-run. By default every non-gitignored file in `cwd` is hashed, plus
   * the nearest lockfile. Provide explicit globs to narrow the scope, or
   * `false` to rebuild on every deploy.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * Extra Build Output route entries merged BEFORE the filesystem handler
   * (redirects, headers, rewrites).
   */
  routes?: BuildOutputRoute[];
}

/**
 * A static site served from a Vercel project, built by a shell command.
 *
 * `StaticSite` runs a build command (via `Command.Build`), content-hashes
 * the output directory, and deploys the result as a static-only Build
 * Output deployment — no serverless function ships, Vercel's static layer
 * answers every request. Use this when your site has its own build step
 * that produces a directory of files: Hugo, Eleventy, Zola, or any custom
 * pipeline.
 *
 * Unchanged inputs skip the rebuild (content-hash memoization) and an
 * unchanged output tree skips the deploy entirely (the deployment id is
 * stable across no-op runs).
 *
 * @resource
 * @product Website
 *
 * @section Basic Usage
 * Point `command` at your build script and `outdir` at where it writes
 * output.
 *
 * @example Deploying a static site
 * ```typescript
 * const site = yield* Vercel.Website.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 * });
 * ```
 *
 * @section Building from a Subdirectory
 * Set `cwd` to run the build command in a subdirectory (e.g. a monorepo
 * package). `outdir` is resolved relative to `cwd`.
 *
 * @example Building a frontend in a monorepo
 * ```typescript
 * const site = yield* Vercel.Website.StaticSite("Web", {
 *   cwd: "apps/web",
 *   command: "npm run build",
 *   outdir: "dist",
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, all non-gitignored files under `cwd` are hashed to decide
 * whether the build should re-run. Use `memo` to narrow the scope.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Vercel.Website.StaticSite("Docs", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   memo: { include: ["content/**", "templates/**", "config.toml"] },
 * });
 * ```
 *
 * @section Class Form
 * Calling `StaticSite` with no arguments returns a constructor you can
 * `extend` to declare the site as a named class — both an `Effect` you can
 * `yield*` to deploy and a type you can reference elsewhere.
 *
 * @example Declaring a site class
 * ```typescript
 * class Blog extends Vercel.Website.StaticSite<Blog>()("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 * }) {}
 *
 * const site = yield* Blog;
 * ```
 */
export const StaticSite: {
  <Self>(): <Req = never>(
    id: string,
    props:
      | InputProps<StaticSiteProps>
      | Effect.Effect<InputProps<StaticSiteProps>, never, Req>,
  ) => Effect.Effect<Self, never, Req | Providers> & {
    new (_: never): Function;
  };
  <Req = never>(
    id: string,
    props:
      | InputProps<StaticSiteProps>
      | Effect.Effect<InputProps<StaticSiteProps>, never, Req>,
  ): Effect.Effect<Function, never, Req | Providers>;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(makeStaticSite(id, propsEff))
    : makeStaticSite(id, propsEff)) as any;

const makeStaticSite = (id: string, propsEff: any) =>
  Effect.gen(function* () {
    const props = yield* resolveWebsiteProps(propsEff);
    // `Build` carries a constant logical id, so it is namespaced under the
    // site's id to keep two sites on one stack from colliding. The
    // Function itself resolves in the CALLER's namespace.
    const build = yield* Command.Build("Build", {
      command: props.command,
      cwd: props.cwd,
      outdir: props.outdir,
      memo: props.memo,
      env: yield* serializeBuildEnv(props.env),
    }).pipe(Namespace.push(id));
    const {
      command: _command,
      cwd: _cwd,
      outdir: _outdir,
      memo: _memo,
      routes,
      ...fnProps
    } = props;
    return yield* Function(id, {
      ...fnProps,
      source: {
        kind: "static",
        dir: build.outdir,
        hash: build.hash.output,
        ...(routes !== undefined ? { routes } : {}),
      },
    } as any);
  });
