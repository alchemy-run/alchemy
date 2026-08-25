import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Command from "../../Command/index.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { initialCwd } from "../../Util/Node.ts";
import { App } from "../App.ts";
import { Certificate } from "../Certificate.ts";
import { IpAssignment } from "../IpAssignment.ts";
import { Service } from "../Service.ts";
import {
  type FrameworkSite,
  type Ref,
  writeStaticServeEntry,
} from "./FrameworkSite.ts";

const CONTAINER_CLIENT_DIR = "/app/dist";
const DEFAULT_PORT = 3000;

const resolveRef = <T>(ref: Ref<T>) =>
  Effect.isEffect(ref) ? ref : Effect.succeed(ref);

export interface StaticSiteProps {
  /**
   * Shell command that produces the site (e.g. `"hugo --minify"`).
   */
  command: string;
  /**
   * Directory the command writes, relative to {@link cwd}.
   */
  outdir: string;
  /**
   * Working directory for {@link command}.
   * @default process cwd
   */
  cwd?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * Environment variables for the build (and the local dev command when
   * `dev.env` is omitted).
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Parent Fly App. When omitted, a `Fly.App` is created. The Service
   * stays in the caller namespace; only `Build` / `Dev` are pushed.
   */
  app?: Ref<App>;
  /**
   * Optional custom hostname. Requests ACME (`Fly.Certificate`) on the App.
   */
  domain?: string;
  /**
   * Answer misses with `index.html` (200) so client-side routes deep-link.
   * Mutually exclusive with {@link errorPage}.
   */
  spa?: boolean;
  /**
   * Serve this file with a real `404` for requests that match no output
   * file. Mutually exclusive with {@link spa}.
   */
  errorPage?: string;
  /**
   * User-defined tags. Accepted for API parity; Fly Services do not
   * surface resource tags.
   */
  tags?: Record<string, string>;
  /**
   * Local dev configuration. When `alchemy dev` runs with `dev.command`,
   * the build is skipped and `command` is spawned as a long-lived child.
   */
  dev?: {
    /**
     * Shell command to run as the local dev server (e.g. `npm run dev`).
     */
    command: string;
    /**
     * Working directory for {@link command}. Defaults to {@link cwd}.
     */
    cwd?: string;
    /**
     * Environment variables for {@link command}.
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
 * Deploy a static site built by a shell command to Fly.
 *
 * `StaticSite` runs a build command (e.g. `npm run build` / `hugo`),
 * content-hashes the output directory, and deploys a Service that serves
 * those files (plus `/health`). Use this when the site has its own build
 * step — Hugo, Zola, Eleventy, or any custom pipeline.
 *
 * For Vite-based projects, prefer `Fly.Website.Vite`.
 *
 * `Build` / `Dev` use constant logical ids under `Namespace.push(id)`.
 * The Service stays in the caller namespace (same as
 * `Cloudflare.Website.StaticSite`).
 *
 * @resource
 * @product Website
 *
 * @section Basic Usage
 * @example Deploying a Hugo site
 * ```typescript
 * const site = yield* Fly.Website.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 * });
 * ```
 *
 * @example SPA-style routing
 * ```typescript
 * const site = yield* Fly.Website.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   spa: true,
 * });
 * ```
 *
 * @section Building from a Subdirectory
 * @example Building a frontend in a monorepo
 * ```typescript
 * const site = yield* Fly.Website.StaticSite("Web", {
 *   cwd: "apps/web",
 *   command: "npm run build",
 *   outdir: "dist",
 * });
 * ```
 *
 * @section Local Development
 * @example External dev command
 * ```typescript
 * const site = yield* Fly.Website.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   dev: { command: "npm run dev" },
 * });
 * ```
 */
export const StaticSite = (id: string, props: StaticSiteProps) =>
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    const isLocal = ctx.dev && remoted !== true;
    const path = yield* Path.Path;

    const empty = (): FrameworkSite => ({
      url: undefined,
      app: undefined,
      service: undefined,
      ip: undefined,
      certificate: undefined,
    });

    if (isLocal && props.dev) {
      const dev = yield* Command.Dev("Dev", {
        command: props.dev.command,
        cwd: props.dev.cwd ?? props.cwd,
        env: props.dev.env ?? props.env,
      }).pipe(Namespace.push(id));
      const url = Output.map(dev.url, (value) => value ?? props.dev?.url);
      return { ...empty(), url };
    }

    const build = yield* Command.Build("Build", {
      command: props.command,
      cwd: props.cwd,
      memo: props.memo,
      outdir: props.outdir,
      env: props.env,
    }).pipe(Namespace.push(id));

    const cwd = path.resolve(initialCwd, props.cwd ?? ".");
    const outdir = path.resolve(cwd, props.outdir);
    const notFoundHandling =
      props.errorPage !== undefined
        ? ("404-page" as const)
        : props.spa === true
          ? ("spa" as const)
          : ("none" as const);

    if (isLocal) {
      const servePath = path.join(path.dirname(outdir), "serve-fly.mjs");
      yield* writeStaticServeEntry({
        filePath: servePath,
        clientDirExpression: JSON.stringify(outdir),
        notFoundHandling,
        errorPage: props.errorPage,
        printUrl: true,
      });
      const dev = yield* Command.Dev("Dev", {
        command: `${process.execPath} ${JSON.stringify(servePath)}`,
        cwd: path.dirname(servePath),
        env: {
          ...props.env,
          PORT: String(DEFAULT_PORT),
          // Depend on Build so the outdir exists before we serve it.
          ALCHEMY_BUILD_HASH: build.hash.output as unknown as string,
        },
      }).pipe(Namespace.push(id));
      return {
        ...empty(),
        url: Output.map(dev.url, (value) => value),
      };
    }

    const servePath = path.join(path.dirname(outdir), "serve-fly.mjs");
    const main = yield* writeStaticServeEntry({
      filePath: servePath,
      clientDirExpression: JSON.stringify(CONTAINER_CLIENT_DIR),
      notFoundHandling,
      errorPage: props.errorPage,
    });

    const app =
      props.app !== undefined
        ? yield* resolveRef(props.app)
        : yield* App("App").pipe(Namespace.push(id));

    const ip = yield* IpAssignment("Shared", {
      app,
      type: "shared_v4",
    }).pipe(Namespace.push(id));

    const service = yield* Service(id, {
      app,
      main,
      port: DEFAULT_PORT,
      env: props.env,
      extraFiles: [
        {
          source: build.outdir as unknown as string,
          dest: "dist",
        },
      ],
    });

    const certificate =
      props.domain !== undefined
        ? yield* Certificate("Certificate", {
            app,
            hostname: props.domain,
            kind: "acme",
          }).pipe(Namespace.push(id))
        : undefined;

    const url =
      props.domain !== undefined ? `https://${props.domain}` : app.url;

    return { url, app, service, ip, certificate };
  });
