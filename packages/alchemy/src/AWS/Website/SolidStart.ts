import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the SolidStart build. */
export const SOLIDSTART_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/solidstart";

/** The AWS Lambda deploy target for the SolidStart build. */
export const SOLIDSTART_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/solidstart/aws";

export interface SolidStartProps extends FrameworkSiteProps {
  /**
   * Prerender routes at build time (nitro's `prerender`); the pages land
   * in the static output and are served from S3 by exact match.
   */
  prerender?: {
    /** Routes to prerender. */
    routes?: string[];
    /** Crawl links from prerendered pages and prerender them too. */
    crawlLinks?: boolean;
  };
}

/**
 * Deploy a [SolidStart](https://start.solidjs.com) application to AWS: the
 * SSR server on a streaming Lambda Function URL, static assets (prerendered
 * pages included) in S3, and a CloudFront distribution whose edge router
 * serves uploaded files from S3 and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/solidstart` with
 * the `@alchemy.run/frontend-frameworks/solidstart/aws` deploy target — both
 * must be installed in your project, alongside `@solidjs/start` and
 * `@solidjs/vite-plugin-nitro-2`.
 *
 * Your `vite.config.ts` needs no adapter wiring: the integration drives the
 * project's own `vite build` and appends its own nitro plugin instance
 * carrying nitro's `aws-lambda` preset with response streaming enabled.
 *
 * ### Creating SolidStart Sites
 * **Example:** Basic SolidStart App
 * ```typescript
 * const site = yield* AWS.Website.SolidStart("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Tune The Server Function
 * ```typescript
 * const site = yield* AWS.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   memorySize: 2048,
 *   env: {
 *     API_BASE: api.url,
 *   },
 * });
 * ```
 *
 * ### Prerendering
 * **Example:** Prerender Routes Into S3
 * ```typescript
 * const site = yield* AWS.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   prerender: { routes: ["/", "/about"] },
 * });
 * ```
 *
 * @resource
 */
export const SolidStart = (
  id: string,
  props: InputProps<SolidStartProps> = {},
) => {
  const p = props as SolidStartProps;
  return makeFrameworkSite(id, props, {
    name: "SolidStart",
    framework: SOLIDSTART_FRAMEWORK_SPECIFIER,
    target: SOLIDSTART_AWS_TARGET_SPECIFIER,
    options: p.prerender ? { nitro: { prerender: p.prerender } } : undefined,
  }).pipe(Namespace.push(id));
};
