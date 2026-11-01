import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { resolveAstroOutput } from "alchemy/Website/AstroOutput";
import * as Effect from "effect/Effect";
import { makeFrameworkSite, type FrameworkSiteProps, type WebsiteOrigin } from "./FrameworkSite.ts";

/** Configuration of an Astro site on STACKIT. */
export type AstroProps = FrameworkSiteProps & {
  /** Serializable overrides merged over `astro.config.*`. The target owns `adapter`. */
  astro?: {
    /** Canonical deployment URL. */
    site?: string;
    /** Deployment base path. */
    base?: string;
    /**
     * Render on demand or prerender every page. Overrides the `output` in your
     * `astro.config.*`.
     * @default the config file's `output`, else `"server"`
     */
    output?: "server" | "static";
    /** Source directory relative to `rootDir`. @default "./src" */
    srcDir?: string;
    /** Static passthrough directory. @default "./public" */
    publicDir?: string;
    /** Production output directory. @default "./dist" */
    outDir?: string;
    /** Route trailing-slash policy. */
    trailingSlash?: "always" | "never" | "ignore";
  };
  /**
   * Where a fully static build is served from: a bucket with no compute, or a Function
   * that can do `assets.notFoundHandling`. A function needs `registry`.
   * @default "bucket"
   */
  origin?: WebsiteOrigin;
};

/**
 * Astro on STACKIT. A server build runs on a `Stackit.Functions.Function` behind a
 * `Stackit.CDN.Distribution`. A fully static build (`output: "static"`) is files in a
 * private `Stackit.ObjectStorage.Bucket` behind the same kind of distribution, with no
 * compute. The target owns the adapter, so omit `adapter` from `astro.config.*`.
 *
 * :::caution[STACKIT Functions is an alpha API]
 * It is available in `eu01` only, and STACKIT documents no container contract, so
 * this site rests on the assumptions listed on `Stackit.Functions.Function`. The
 * image is built with Docker on the deploying machine.
 * :::
 *
 * During `alchemy dev` the site is the framework's own dev server, and no cloud
 * resources are declared. `Alchemy.remote()` opts back into the live deployment.
 *
 * ### Creating a Website
 * **Example:** A server build, with a STACKIT registry
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 * import * as Config from "effect/Config";
 *
 * const images = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const pusher = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: images.name,
 *   registryUrl: images.url,
 *   credentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 * });
 * const puller = yield* Stackit.Functions.PullCredential("Puller", {
 *   address: images.registryHost,
 *   username: pusher.robotName,
 *   password: pusher.secret,
 * });
 * const site = yield* Stackit.Website.Astro("Web", {
 *   rootDir: "./app",
 *   registry: {
 *     repository: Output.interpolate`${images.imagePrefix}/web`,
 *     username: pusher.robotName,
 *     password: pusher.secret,
 *   },
 *   pullCredential: puller.pullCredentialId,
 * });
 * // site.url is the CDN's URL; site.server is the function behind it.
 * ```
 *
 * ### Static Output
 * The CDN has no rewrite and no error pages, so a bucket gives no 404 page. A bucket
 * has no object for `/` either, and STACKIT documents no default document for a bucket
 * origin, so check `/` on your first deploy. `origin: "function"` covers both.
 *
 * **Example:** Prerendered documentation on a bucket
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const docs = yield* Stackit.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 * });
 * ```
 *
 * **Example:** Prerendered documentation with a 404 page, on a Function
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const docs = yield* Stackit.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 *   origin: "function",
 *   registry: { repository: "ghcr.io/my-org/docs" },
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Function limits, CDN settings and a custom domain
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.Astro("Web", {
 *   registry: { repository: "ghcr.io/my-org/web" },
 *   env: { API_BASE: "https://api.example.com" },
 *   function: { concurrency: 50, maxScale: 10 },
 *   cdn: { regions: ["EU", "US"] },
 *   domain: "www.example.com",
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Astro = (id: string, propsIn: InputProps<AstroProps> = {}) => {
  const props = propsIn as AstroProps;
  return resolveAstroOutput({ rootDir: props.rootDir, output: props.astro?.output }).pipe(
    Effect.flatMap((output) =>
      makeFrameworkSite(id, propsIn, {
        name: "Astro",
        framework: "@alchemy.run/frontend-frameworks/astro",
        target: "@alchemy.run/frontend-frameworks/astro/stackit",
        options: { astro: { ...props.astro, output } },
        assetsOnly: output === "static" && props.origin !== "function",
        basePath: props.astro?.base,
        notFoundHandling: "none",
      }),
    ),
    Namespace.push(id),
  );
};
