import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the SvelteKit build. */
export const SVELTEKIT_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/sveltekit";

/** The AWS Lambda deploy target for the SvelteKit build. */
export const SVELTEKIT_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/sveltekit/aws";

export interface SvelteKitProps extends FrameworkSiteProps {
  /**
   * SvelteKit configuration passed to the `sveltekit(config)` Vite plugin
   * (kit v3 takes its config in memory — a `svelte.config.js` on disk is an
   * upstream error). The `adapter` field is injected by the AWS deploy
   * target and may not be set here. Must be JSON-serializable (it persists
   * in state).
   */
  kit?: Record<string, unknown>;
}

/**
 * Deploy a SvelteKit application to AWS: kit's SSR server on a streaming
 * Lambda Function URL, static assets (prerendered pages included) in S3,
 * and a CloudFront distribution whose edge router serves uploaded files
 * from S3 and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/sveltekit` with the
 * `@alchemy.run/frontend-frameworks/sveltekit/aws` deploy target (an in-memory
 * kit adapter emitting a streaming Lambda handler) — both must be
 * installed in your project.
 *
 * ### Creating SvelteKit Sites
 * **Example:** Basic SvelteKit App
 * ```typescript
 * const site = yield* AWS.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.SvelteKit("Web", {
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
 * const site = yield* AWS.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 *   server: {
 *     memorySize: 2048,
 *     environment: {
 *       API_BASE: api.url,
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const SvelteKit = (id: string, props: SvelteKitProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "SvelteKit",
    framework: SVELTEKIT_FRAMEWORK_SPECIFIER,
    target: SVELTEKIT_AWS_TARGET_SPECIFIER,
    options: props.kit ? { kit: props.kit } : undefined,
  }).pipe(Namespace.push(id));
