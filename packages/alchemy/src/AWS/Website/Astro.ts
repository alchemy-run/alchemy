import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Astro build. */
export const ASTRO_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/astro";

/** The AWS Lambda deploy target for the Astro build. */
export const ASTRO_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/astro/aws";

export interface AstroProps extends FrameworkSiteProps {
  // Astro config overrides, merged OVER the project's own `astro.config.*`
  // (which loads natively). Flat — the composite IS Astro, so keys need no
  // namespace. `adapter` is owned by the AWS deploy target.
  /** The full URL the site deploys to (`Astro.site`). */
  site?: string;
  /** Base path the site deploys under. */
  base?: string;
  /**
   * Astro output target. `"server"` renders pages on demand in the
   * Lambda; individual pages opt into prerendering with
   * `export const prerender = true`. `"static"` prerenders every page at
   * build time and deploys assets-only (no Lambda).
   * @default "server"
   */
  output?: "server" | "static";
  /** Source directory, relative to `rootDir`. @default "./src" */
  srcDir?: string;
  /** Public (static passthrough) directory. @default "./public" */
  publicDir?: string;
  /** Build output directory. @default "./dist" */
  outDir?: string;
  /** Trailing-slash handling for routes. */
  trailingSlash?: "always" | "never" | "ignore";
  /**
   * Serve the built error page (e.g. astro's `404.html`) for requests that
   * match no uploaded file. Only applies to `output: "static"` sites — a
   * server-backed site forwards misses to the Lambda instead.
   */
  errorPage?: string;
  /**
   * Answer misses with the index page (200) instead of a 404. Only applies
   * to `output: "static"` sites.
   */
  spa?: boolean;
}

/**
 * Deploy an [Astro](https://astro.build) application to AWS: the server
 * bundle on a streaming Lambda Function URL, static assets (prerendered
 * pages included) in S3, and a CloudFront distribution whose edge router
 * serves uploaded files from S3 and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/astro` with the
 * `@alchemy.run/frontend-frameworks/astro/aws` deploy target (a wrangler-free
 * AWS Lambda adapter is injected — your `astro.config.*` must not declare
 * one) — the package must be installed in your project.
 *
 * Pages render on demand by default (`output: "server"`); pages that
 * `export const prerender = true` are prerendered at build time and served
 * from S3. With `output: "static"` every page is prerendered and the
 * deploy is assets-only — no Lambda.
 *
 * ### Creating Astro Sites
 * **Example:** Basic Astro App
 * ```typescript
 * const site = yield* AWS.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Astro("Web", {
 *   rootDir: "./app",
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * ### Static Sites
 * **Example:** Fully Static Astro Site
 * ```typescript
 * const site = yield* AWS.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   output: "static",
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Tune The Server Function
 * ```typescript
 * const site = yield* AWS.Website.Astro("Web", {
 *   rootDir: "./app",
 *   memorySize: 2048,
 *   env: {
 *     API_BASE: api.url,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Astro = (id: string, props: InputProps<AstroProps> = {}) => {
  const p = props as AstroProps;
  // Server output is the documented default: astro's own zero-config
  // default is `"static"`. The inline config merges OVER the project's
  // `astro.config.*`, so an explicit file-level `output` is superseded;
  // opt into a fully prerendered site with `output: "static"`.
  const output = p.output ?? "server";
  return makeFrameworkSite(id, props, {
    name: "Astro",
    framework: ASTRO_FRAMEWORK_SPECIFIER,
    target: ASTRO_AWS_TARGET_SPECIFIER,
    options: {
      astro: {
        site: p.site,
        base: p.base,
        output,
        srcDir: p.srcDir,
        publicDir: p.publicDir,
        outDir: p.outDir,
        trailingSlash: p.trailingSlash,
      },
    },
    static:
      output === "static" ? { spa: p.spa, errorPage: p.errorPage } : undefined,
  }).pipe(Namespace.push(id));
};
