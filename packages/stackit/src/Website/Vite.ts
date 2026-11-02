import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps, type WebsiteOrigin } from "./FrameworkSite.ts";

/** Configuration of a Vite site on STACKIT. */
export type ViteProps = FrameworkSiteProps & {
  /** Serializable overrides merged over `vite.config.*`. */
  vite?: {
    /** Build output directory. @default "dist" */
    outDir?: string;
    /** Public base path. Uploads go under it. @default "/" */
    base?: string;
  };
  /**
   * Where the build is served from: a bucket with no compute, or a Function that
   * can do `assets.notFoundHandling`. A function needs `registry`.
   * @default "bucket"
   */
  origin?: WebsiteOrigin;
};

/**
 * A plain Vite build as static files in a private `Stackit.ObjectStorage.Bucket`
 * behind a `Stackit.CDN.Distribution`. No compute runs. Files with a content hash in
 * their name are cached for good, HTML is not cached, and a deploy purges the
 * unhashed files that changed.
 *
 * The CDN has no rewrite and no error pages, so on a bucket there is no client-side
 * routing fallback: a deep link to a route with no file fails. Use hash routing,
 * or set `origin: "function"` for a Function that serves the same files with
 * `assets.notFoundHandling`.
 *
 * :::caution[`/` is unconfirmed]
 * A bucket has no object for `/`, and STACKIT documents no default document for a
 * bucket origin. Pages under a path are stored at their own URLs. Check `/` on your
 * first deploy. `origin: "function"` serves it regardless.
 * :::
 *
 * During `alchemy dev` the site is the framework's own dev server, and no cloud
 * resources are declared. `Alchemy.remote()` opts back into the live deployment.
 *
 * ### Creating a Website
 * **Example:** A Vite build behind the CDN
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.Vite("Web", { rootDir: "./app" });
 * // site.url is the CDN's URL; site.bucket holds the files.
 * ```
 *
 * **Example:** A base path and a custom domain
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.Vite("Docs", {
 *   vite: { outDir: "build", base: "/docs/" },
 *   domain: "www.example.com",
 * });
 * ```
 *
 * ### Client-side Routing
 * **Example:** A single-page app with deep links, served by a Function
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.Vite("App", {
 *   origin: "function",
 *   registry: { repository: "ghcr.io/my-org/app" },
 *   assets: { notFoundHandling: "single-page-application" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vite = (id: string, propsIn: InputProps<ViteProps> = {}) => {
  const props = propsIn as ViteProps;
  return makeFrameworkSite(id, propsIn, {
    name: "Vite",
    framework: "@alchemy.run/frontend-frameworks/vite",
    target: "@alchemy.run/frontend-frameworks/vite/stackit",
    options: { vite: props.vite },
    assetsOnly: props.origin !== "function",
    basePath: props.vite?.base,
    notFoundHandling: "spa",
  }).pipe(Namespace.push(id));
};
