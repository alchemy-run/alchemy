import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";
import { viteFrameworkOptions, type ViteProps } from "./Vite.ts";

export const FOLDKIT_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/foldkit";
export const FOLDKIT_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/foldkit/aws";

/** Configuration for a Foldkit website on AWS. */
export interface FoldkitProps extends FrameworkSiteProps {
  /**
   * Deployment topology, declared before building. `"server"` deploys a
   * Lambda for SSR/hybrid routes; `"static"` deploys only prerendered assets.
   * Omit for an existing browser-only SPA. A server build requires an explicit choice.
   */
  output?: "server" | "static";
  /** Serializable overrides merged over vite.config.*. */
  vite?: ViteProps["vite"];
  /** Alternate Vite configuration file, relative to rootDir. */
  config?: string;
  /** Serve index.html for missing paths on an assets-only site. @default true for SPA, false for static */
  spa?: boolean;
  /** Serve a custom 404 page on an assets-only site. Mutually exclusive with spa. */
  errorPage?: string;
}

/**
 * Deploy a [Foldkit](https://foldkit.dev) application to AWS with assets in
 * S3 behind CloudFront. Browser-only apps use SPA routing by default.
 * With `output: "server"`, Foldkit's generated fetch handler runs on a
 * streaming Lambda Function URL; prerendered pages and assets stay in S3.
 *
 * The project's Foldkit Vite plugin owns rendering and prerendering.
 * Enable `ssr.build` there for SSR or SSG. Alchemy builds through
 * `@alchemy.run/frontend-frameworks/foldkit` with its AWS target, using the
 * same Lambda adapter as the other frameworks. No application wrapper is required.
 *
 * During `alchemy dev`, Foldkit's native Vite server provides live reload
 * without creating cloud resources. `Alchemy.remote()` opts into deployment.
 *
 * ### Creating a Website
 * **Example:** Browser-only SPA
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web", { rootDir: "./app" });
 * ```
 *
 * ### Server Rendering
 * **Example:** SSR with prerendered routes
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   rootDir: "./app",
 *   output: "server",
 *   memorySize: 2048,
 *   env: { API_BASE: "https://api.example.com" },
 * });
 * ```
 *
 * ### Static Generation
 * **Example:** Prerendered pages without a Lambda
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Docs", {
 *   rootDir: "./docs",
 *   output: "static",
 *   errorPage: "404.html",
 * });
 * ```
 *
 * @resource
 */
export const Foldkit = (id: string, props: InputProps<FoldkitProps> = {}) => {
  const p = props as FoldkitProps;
  return makeFrameworkSite(id, props, {
    name: "Foldkit",
    framework: FOLDKIT_FRAMEWORK_SPECIFIER,
    target: FOLDKIT_AWS_TARGET_SPECIFIER,
    options: { ...viteFrameworkOptions(p), output: p.output ?? "spa" },
    static:
      p.output === "server"
        ? undefined
        : {
            spa: p.spa ?? (p.output === undefined && p.errorPage === undefined),
            errorPage: p.errorPage,
          },
  }).pipe(Namespace.push(id));
};
