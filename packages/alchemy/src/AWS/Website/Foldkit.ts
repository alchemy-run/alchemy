import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the client-only Vite build. */
export const VITE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vite";

/** The AWS deploy target for the client-only Vite build. */
export const VITE_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vite/aws";

export interface FoldkitProps extends FrameworkSiteProps {
  /**
   * Serve the built error page for requests that match no uploaded file
   * instead of the SPA index fallback. Setting this implies `spa: false`
   * unless `spa` is set explicitly.
   */
  errorPage?: string;
  /**
   * Answer misses with the index page (200) instead of a 404, so deep
   * links boot the app and the Foldkit router takes over.
   * @default true
   */
  spa?: boolean;
}

/**
 * Deploy a [Foldkit](https://foldkit.dev) application to AWS: static
 * assets in S3 behind a CloudFront distribution (or attached to a shared
 * `AWS.Website.Router`).
 *
 * Foldkit apps are client-only Vite projects, so `Foldkit` drives the
 * project's own `vite build` — the Foldkit Vite plugin in the app's
 * `vite.config.ts` runs as-is — and deploys the client output as static
 * assets. No server function is created; the deployment is assets-only.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/vite` (the
 * client-only Vite integration) — the package must be installed in your
 * project.
 *
 * Foldkit apps route on the client, so unmatched paths serve `index.html`
 * by default (`spa: true`) and the Foldkit router takes over.
 *
 * During `alchemy dev` the site is Vite's own dev server (native HMR) and
 * no cloud resources are declared; `Alchemy.remote()` opts back into the
 * full live deployment.
 *
 * @resource
 * @section Deploying a Foldkit App
 * A single call builds the project and deploys the client output as
 * static assets — no configuration required.
 *
 * @example Foldkit app
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Website");
 * ```
 *
 * @example Foldkit project in a subdirectory
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Website", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * @section Custom Domain
 * @example Serve the site at a Route 53 domain
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Website", {
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * @section Single-Page Application Routing
 * Unmatched paths serve `index.html` by default so deep links boot the
 * app and the Foldkit router resolves the route. A site that ships real
 * 404 content can opt out.
 *
 * @example Serving a real 404 page
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Website", {
 *   spa: false,
 *   errorPage: "404.html",
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether a
 * rebuild is needed. Use `memo` to narrow the scope when your project
 * has large directories that don't affect the build output.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Website", {
 *   memo: {
 *     include: ["src/**", "public/**", "index.html", "package.json"],
 *   },
 * });
 * ```
 */
export const Foldkit = (id: string, props: FoldkitProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Foldkit",
    framework: VITE_FRAMEWORK_SPECIFIER,
    target: VITE_AWS_TARGET_SPECIFIER,
    // Assets-only: a Foldkit build produces no server code. SPA fallback
    // is the default (client-side router); an explicit errorPage opts out.
    static: {
      spa: props.spa ?? props.errorPage === undefined,
      errorPage: props.errorPage,
    },
  }).pipe(Namespace.push(id));
