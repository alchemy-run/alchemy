import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { Exec } from "../os/index.ts";
import type { Scope } from "../scope.ts";
import { isSecret } from "../secret.ts";
import { dedent } from "../util/dedent.ts";
import { Assets } from "./assets.ts";
import type { Bindings } from "./bindings.ts";
import { DEFAULT_COMPATIBILITY_DATE } from "./compatibility-date.gen.ts";
import { unionCompatibilityFlags } from "./compatibility-presets.ts";
import { writeMiniflareSymlink } from "./website.ts";
import type { AssetsConfig, FinalWorkerProps, WorkerProps } from "./worker.ts";
import { WranglerJson, type WranglerJsonSpec } from "./wrangler.json.ts";

export interface WebsitePluginProps extends AssetsConfig {
  /**
   * Path to the main entrypoint script
   */
  main?: string;
  /**
   * The root directory of the project
   * @default process.cwd()
   */
  cwd?: string;
  /**
   * Configuration for the build command
   *
   * If not provided, the build is assumed to have already happened.
   */
  build:
    | string
    | {
        /**
         * The command to run to build the site
         */
        command: string;
        /**
         * Additional environment variables to set when running the build command
         */
        env?: Record<string, string>;
        /**
         * Whether to memoize the command (only re-run if the command changes)
         *
         * When set to `true`, the command will only be re-executed if the command string changes.
         *
         * When set to an object with `patterns`, the command will be re-executed if either:
         * 1. The command string changes, or
         * 2. The contents of any files matching the glob patterns change
         *
         * ⚠️ **Important Note**: When using memoization with build commands, the build outputs
         * will not be produced if the command is memoized. This is because the command is not
         * actually executed when memoized. Consider disabling memoization in CI environments:
         *
         * @example
         * // Disable memoization in CI to ensure build outputs are always produced
         * await Website("my-website", {
         *   command: "vite build",
         *   memoize: process.env.CI ? false : {
         *     patterns: ["./src/**"]
         *   }
         * });
         *
         * @default false
         */
        memoize?: boolean | { patterns: string[] };
      };
  /**
   * Configuration for the dev command
   */
  dev?:
    | string
    | {
        /**
         * The command to run to start the dev server
         */
        command: string;
        /**
         * Additional environment variables to set when running the dev command
         */
        env?: Record<string, string>;
      };
  /**
   * The directory containing static assets
   */
  dist: string | ((props: WorkerProps) => string);

  /**
   * Configuration for the wrangler.json file
   */
  wrangler?: {
    /**
     * Path to the wrangler.json file
     *
     * @default .alchemy/local/wrangler.jsonc
     */
    path?: string;
    /**
     * The main entry point for the worker
     *
     * @default worker.entrypoint
     */
    main?: string;
    /**
     * Hook to modify the wrangler.json object before it's written
     *
     * This function receives the generated wrangler.json spec and should return
     * a modified version. It's applied as the final transformation before the
     * file is written to disk.
     *
     * @param spec - The generated wrangler.json specification
     * @returns The modified wrangler.json specification
     */
    transform?: (
      spec: WranglerJsonSpec,
    ) => WranglerJsonSpec | Promise<WranglerJsonSpec>;
    /**
     * Whether to include secrets in the wrangler.json file
     *
     * @default true if no path is specified, false otherwise
     */
    secrets?: boolean;
  };
}

export function isWebsitePlugin(value: unknown): value is WebsitePlugin {
  return typeof value === "object" && value !== null && "apply" in value;
}

export type WebsitePlugin = {
  apply(
    scope: Scope,
    workerProps: WorkerProps<Bindings>,
  ): Promise<FinalWorkerProps<Bindings>>;
};

export function WebsitePlugin<B extends Bindings>(
  props: WebsitePluginProps,
): WebsitePlugin {
  return {
    apply: async (
      scope: Scope,
      workerProps: WorkerProps<B>,
    ): Promise<FinalWorkerProps<B>> => {
      const build =
        typeof props.build === "string"
          ? { command: props.build }
          : props.build;
      const cwd = props.cwd ?? process.cwd();
      const assets =
        typeof props.dist === "string"
          ? path.resolve(cwd, props.dist)
          : props.dist(workerProps);
      const local = path.resolve(cwd, ".alchemy", "local");
      const entrypoint = path.resolve(
        cwd,
        workerProps.entrypoint ?? props.main ?? path.join(local, "worker.js"),
      );
      const wrangler = {
        path: path.resolve(
          cwd,
          props.wrangler?.path ?? path.join(local, "wrangler.jsonc"),
        ),
        main: props.wrangler?.main
          ? path.resolve(cwd, props.wrangler.main)
          : entrypoint,
      };

      const secrets = props.wrangler?.secrets ?? !props.wrangler?.path;
      const env = {
        ...(process.env ?? {}),
        ...(workerProps.env ?? {}),
        ...Object.fromEntries(
          Object.entries(workerProps.bindings ?? {}).flatMap(([key, value]) => {
            if (typeof value === "string" || (isSecret(value) && secrets)) {
              return [[key, value]];
            }
            return [];
          }),
        ),
      };
      const worker = {
        ...workerProps,
        noBundle: workerProps.noBundle ?? true,
        cwd: path.relative(process.cwd(), cwd),
        compatibilityFlags: unionCompatibilityFlags(
          workerProps.compatibility,
          workerProps.compatibilityFlags,
        ),
        compatibilityDate:
          workerProps.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
        assets: {
          html_handling: props.html_handling ?? "auto-trailing-slash",
          not_found_handling: props.not_found_handling ?? "none",
          run_worker_first: props.run_worker_first ?? false,
          _headers: props._headers,
          _redirects: props._redirects,
        },
        entrypoint: path.relative(cwd, entrypoint),
      } as FinalWorkerProps<B> & { name: string };

      assert(
        !workerProps.bindings?.ASSETS,
        "ASSETS binding is reserved for internal use",
      );
      if (!workerProps.entrypoint) {
        await fs.mkdir(path.dirname(entrypoint), { recursive: true });
        const content =
          workerProps.script ??
          dedent`
        export default {
            async fetch(request, env) {
                return new Response("Not Found", { status: 404 });
            },
        };`;
        await fs.writeFile(entrypoint, content);
      }

      await writeMiniflareSymlink(cwd);

      await WranglerJson("wrangler.jsonc", {
        path: path.relative(cwd, wrangler.path),
        worker,
        assets: {
          binding: "ASSETS",
          directory: path.relative(cwd, assets),
        },
        main: path.relative(cwd, wrangler.main),
        secrets,
        transform: {
          wrangler: props.wrangler?.transform,
        },
      });

      if (build && !scope.local) {
        await Exec("build", {
          cwd: path.relative(process.cwd(), cwd),
          command: build.command,
          env: {
            ...env,
            ...(typeof build === "object" ? build.env : {}),
            NODE_ENV: "production",
          },
          memoize: typeof build === "object" ? build.memoize : undefined,
        });
      }

      let url: string | undefined;
      if (props.dev && scope.local) {
        url = await scope.spawn(worker.name, {
          cmd: typeof props.dev === "string" ? props.dev : props.dev.command,
          cwd: cwd,
          extract: (line) => {
            const URL_REGEX =
              /http:\/\/(localhost|0\.0\.0\.0|127\.0\.0\.1|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+\/?/;
            const match = line
              .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
              .match(URL_REGEX);
            if (match) {
              return match[0];
            }
          },
          env: {
            ...Object.fromEntries(
              Object.entries(env ?? {}).flatMap(([key, value]) => {
                if (isSecret(value)) {
                  return [[key, value.unencrypted]];
                }
                if (typeof value === "string") {
                  return [[key, value]];
                }
                return [];
              }),
            ),
            ...(typeof props.dev === "object" ? props.dev.env : {}),
            FORCE_COLOR: "1",
            ...process.env,
            // NOTE: we must set this to ensure the user does not accidentally set `NODE_ENV=production`
            // which breaks `vite dev` (it won't, for example, re-write `process.env.TSS_APP_BASE` in the `.js` client side bundle)
            NODE_ENV: "development",
          },
        });
      }
      return {
        ...worker,
        bindings: {
          ...worker.bindings,
          ...(!scope.local
            ? {
                ASSETS: await Assets("assets", {
                  path: path.relative(process.cwd(), assets),
                }),
              }
            : {}),
        },
        dev: url ? { url } : undefined,
      } as FinalWorkerProps<B>;
    },
  };
}
