import { exec } from "child_process";
import { promises as fs } from "fs";
import path from "node:path";
import { promisify } from "util";
import type { Context } from "../context";
import type { BundleProps } from "../esbuild/bundle";
import { Resource } from "../resource";
import { createCloudflareApi } from "./api";
import type { Bindings } from "./bindings";
import { generateAssetManifest } from "./generate-asset-manifest";
import { KVNamespace } from "./kv-namespace";
import { uploadAssetManifest } from "./upload-asset-manifest";
import { Worker } from "./worker";

const __dirname = import.meta.dirname;

/**
 * Idea of using KV with timeout inspired by SST: https://github.com/sst/sst/blob/dev/platform/src/components/cloudflare/static-site.ts
 */

/**
 * Properties for creating or updating a StaticSite
 */
export interface StaticSiteProps {
  /**
   * Name for the site
   * This is mandatory - must be explicitly specified
   */
  name: string;

  /**
   * Path to the directory containing static assets
   */
  dir: string;

  /**
   * Custom Worker script to serve the site
   * If not provided, a default script will be used
   */
  workerScript?: string;

  /**
   * Worker script format
   * 'esm' - ECMAScript modules (default)
   * 'cjs' - CommonJS modules
   * @default 'esm'
   */
  format?: "esm" | "cjs";

  /**
   * Custom error page path (relative to directory)
   * @example "404.html"
   */
  errorPage?: string;

  /**
   * Index page filename
   * @default "index.html"
   */
  indexPage?: string;

  /**
   * Configure how the static site's assets are uploaded to KV
   */
  assets?: {
    /**
     * File options for configuring caching behavior
     */
    fileOptions?: {
      /**
       * File pattern(s) to match
       * Can be a glob string or array of glob strings
       */
      files: string | string[];

      /**
       * Files to ignore (glob patterns)
       */
      ignore?: string | string[];

      /**
       * Cache-Control header to set for matching files
       */
      cacheControl: string;

      /**
       * Content-Type to set (overrides auto-detection)
       */
      contentType?: string;
    }[];
  };

  /**
   * Whether the site should be deployed to production
   * @default true
   */
  production?: boolean;

  /**
   * Custom domain for the site
   */
  domain?:
    | string
    | {
        name: string;
        redirects?: string[];
      };

  build?: {
    /**
     * Command to run before deploying the site
     * Will be executed in the shell to build the site
     */
    command?: string;
  };

  /**
   * Bundle options for the worker script
   */
  bundle?: Partial<BundleProps>;

  /**
   * Additional workers to route requests to.
   */
  routes?: {
    [key: string]: Worker;
  };
}

/**
 * Output returned after StaticSite creation/update
 */
export interface StaticSite extends Resource<"cloudflare::StaticSite"> {
  /**
   * The ID of the worker
   */
  workerId: string;

  /**
   * Name for the site
   */
  name: string;

  /**
   * Path to the directory containing static assets
   */
  directory: string;

  /**
   * Worker script format
   */
  format?: "esm" | "cjs";

  /**
   * Custom error page path
   */
  errorPage?: string;

  /**
   * Index page filename
   */
  indexPage?: string;

  /**
   * Time at which the site was created
   */
  createdAt: number;

  /**
   * Time at which the site was last updated
   */
  updatedAt: number;

  /**
   * List of uploaded asset files
   */
  assets: string[];

  /**
   * Custom domain for the site
   */
  domain?:
    | string
    | {
        name: string;
        redirects?: string[];
      };

  /**
   * Whether the site is deployed to production
   */
  production?: boolean;

  /**
   * The URL of the deployed site
   */
  url?: string;

  /**
   * Information about the backend worker if configured
   */
  routes?: Record<string, string>;
}

/**
 * A StaticSite resource deploys static web content to Cloudflare Workers, using KV for asset storage.
 * It provides an efficient way to serve static websites with global distribution and caching.
 *
 * @example
 * // Create a basic static site with default settings
 * const basicSite = await StaticSite("my-site", {
 *   name: "my-site",
 *   dir: "./dist",
 *   url: true
 * });
 *
 * @example
 * // Create a static site with custom build command and minification disabled
 * const devSite = await StaticSite("dev-site", {
 *   name: "dev-site",
 *   dir: "./public",
 *   build: {
 *     command: "npm run build"
 *   },
 *   bundle: {
 *     minify: false
 *   }
 * });
 *
 * @example
 * // Create a static site with a backend API worker
 * const backend = await Worker("api-backend", {
 *   name: "api-backend",
 *   entrypoint: "./src/api.ts"
 * });
 *
 * const fullSite = await StaticSite("full-site", {
 *   name: "full-site",
 *   dir: "./dist",
 *   routes: {
 *     "/api/*": backend
 *   }
 * });
 *
 * @example
 * // Create a static site with custom error page and index
 * const customSite = await StaticSite("custom-site", {
 *   name: "custom-site",
 *   dir: "./www",
 *   errorPage: "404.html",
 *   indexPage: "home.html",
 *   domain: "www.example.com"
 * });
 *
 * @see https://developers.cloudflare.com/workers/platform/sites
 */
export const StaticSite = Resource(
  "cloudflare::StaticSite",
  {
    alwaysUpdate: true,
  },
  async function (
    this: Context<StaticSite>,
    id: string,
    props: StaticSiteProps
  ) {
    if (this.phase === "delete") {
      // For delete operations, we'll rely on the Worker delete to clean up
      // Return empty output for deleted state
      return this.destroy();
    }

    // Validate that a name is provided
    if (!props.name) {
      throw new Error(
        "StaticSite name is required - must be explicitly specified"
      );
    }

    // Validate directory exists
    if (!props.dir) {
      throw new Error("Directory is required for StaticSite");
    }

    // Run build command if provided
    if (props.build?.command) {
      try {
        if (!this.quiet) {
          console.log(props.build.command);
        }
        const execAsync = promisify(exec);
        const { stdout, stderr } = await execAsync(props.build.command, {
          cwd: process.cwd(),
        });

        if (stdout && !this.quiet) console.log(stdout);
      } catch (error: any) {
        // Log detailed error information
        console.error(`Build command failed with exit code ${error.code}`);
        if (error.stdout) console.error(`Command stdout: ${error.stdout}`);
        if (error.stderr) console.error(`Command stderr: ${error.stderr}`);

        // Throw a more descriptive error that includes the exit code and stderr
        throw new Error(
          `Build command "${props.build.command}" failed with exit code ${error.code}:\n${error.stderr || error.message}`
        );
      }
    }

    try {
      const dirStat = await fs.stat(props.dir);
      if (!dirStat.isDirectory()) {
        throw new Error(`"${props.dir}" is not a directory`);
      }
    } catch (error: any) {
      throw new Error(
        `Directory "${props.dir}" does not exist: ${error.message}`
      );
    }

    // Use the provided name
    const siteName = props.name;
    const indexPage = props.indexPage || "index.html";

    // Create Cloudflare API client with automatic account discovery
    const api = await createCloudflareApi();

    // Step 1: Create or get the KV namespace for assets
    const [kv, assetManifest] = await Promise.all([
      KVNamespace("assets", {
        title: `${siteName}-assets`,
      }),
      generateAssetManifest(props.dir),
    ]);

    // Step 3: Upload assets to KV
    await uploadAssetManifest(api, kv.namespaceId, assetManifest);

    // Prepare the bindings for the worker
    const bindings: Bindings = {
      ASSETS: kv,
      INDEX_PAGE: indexPage,
      // Add error page binding if specified
      ...(props.errorPage ? { ERROR_PAGE: props.errorPage } : {}),
    };

    const routes: Record<string, string> = {};
    // Create backend worker if configured
    if (props.routes) {
      for (const [path, worker] of Object.entries(props.routes)) {
        // @ts-ignore - TODO: need to use Resolved<Worker> to get the string ...
        routes[path] = worker.id;
        bindings[`ROUTE_${worker.id}`] = worker;
      }
    }

    // Create asset manifest banner for static site router
    const assetManifestBanner = `const __ASSET_MANIFEST__ = ${JSON.stringify(
      Object.fromEntries(assetManifest.map((item) => [item.key, item.hash]))
    )};\n`;

    const bundleOptions = {
      ...props.bundle,
      options: {
        ...props.bundle?.options,
        banner: {
          js: assetManifestBanner,
          ...props.bundle?.options?.banner,
        },
      },
    };

    // Determine the entrypoint file - check for .ts first, fallback to .js
    let entrypointFile = "static-site-router.js";
    try {
      const tsFile = path.resolve(__dirname, "static-site-router.ts");
      await fs.access(tsFile);
      // If we reach here, the TypeScript file exists
      entrypointFile = "static-site-router.ts";
    } catch (error) {
      // TypeScript file doesn't exist, use JavaScript (default)
    }

    const worker = await Worker("worker", {
      name: siteName,
      url: true,
      format: props.format || "esm",
      // If a custom worker script is provided, use it, otherwise use the entrypoint from router
      ...(props.workerScript
        ? { script: props.workerScript }
        : {
            entrypoint: path.resolve(__dirname, entrypointFile),
            bundle: bundleOptions as any,
          }),
      bindings,
      env: {
        ...Object.fromEntries(
          Object.entries(routes).map(([key, value]) => [
            `__ROUTE_${value}`,
            key,
          ])
        ),
      },
    });

    const now = Date.now();

    return this({
      workerId: worker.id,
      name: siteName,
      directory: props.dir,
      format: props.format || "esm",
      errorPage: props.errorPage,
      indexPage,
      assets: assetManifest.map((item) => item.key),
      createdAt: this.output?.createdAt || now,
      updatedAt: now,
      domain: props.domain,
      production: props.production !== false,
      url: worker.url,
      routes,
    });
  }
);
