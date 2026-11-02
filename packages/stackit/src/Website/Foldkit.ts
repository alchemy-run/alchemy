import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps, type WebsiteOrigin } from "./FrameworkSite.ts";
import type { ViteProps } from "./Vite.ts";

/** Configuration of a Foldkit site on STACKIT. */
export type FoldkitProps = FrameworkSiteProps & {
  /** Serializable overrides merged over `vite.config.*`. */
  vite?: ViteProps["vite"];
  /**
   * `spa` is browser-only and `static` is prerendered, both assets-only. `server`
   * renders on a Function and needs `registry`.
   * @default "spa"
   */
  output?: "spa" | "static" | "server";
  /**
   * Where the build is served from: a bucket with no compute, or a Function that
   * can do `assets.notFoundHandling`. A function needs `registry`.
   * @default "bucket"
   */
  origin?: WebsiteOrigin;
};

/**
 * Foldkit on STACKIT. Browser-only and prerendered builds are static files in a
 * private `Stackit.ObjectStorage.Bucket` behind a `Stackit.CDN.Distribution`, with no
 * compute. `output: "server"` renders on a `Stackit.Functions.Function` behind the
 * same CDN.
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
 * **Example:** A browser-only app behind the CDN
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.Foldkit("Web", { rootDir: "./app" });
 * ```
 *
 * **Example:** Server rendering on a Function
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.Foldkit("Web", {
 *   output: "server",
 *   registry: { repository: "ghcr.io/my-org/web" },
 * });
 * ```
 *
 * ### Client-side Routing
 * **Example:** Deep links, served by a Function
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.Website.Foldkit("Web", {
 *   origin: "function",
 *   registry: { repository: "ghcr.io/my-org/web" },
 *   assets: { notFoundHandling: "single-page-application" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Foldkit = (id: string, propsIn: InputProps<FoldkitProps> = {}) => {
  const props = propsIn as FoldkitProps;
  const output = props.output ?? "spa";
  return makeFrameworkSite(id, propsIn, {
    name: "Foldkit",
    framework: "@alchemy.run/frontend-frameworks/foldkit",
    target: "@alchemy.run/frontend-frameworks/foldkit/stackit",
    options: { vite: props.vite, output },
    assetsOnly: output !== "server" && props.origin !== "function",
    basePath: props.vite?.base,
  }).pipe(Namespace.push(id));
};
