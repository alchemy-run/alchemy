import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Waku build. */
export const WAKU_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/waku";

/** The AWS Lambda deploy target for the Waku build. */
export const WAKU_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/waku/aws";

export interface WakuProps extends FrameworkSiteProps {
  // Waku config overrides, merged over the project's own `waku.config.ts`.
  // Flat — the composite IS Waku. `unstable_adapter` is owned by the AWS
  // deploy target.
  /** Source directory, relative to `rootDir` (waku's `srcDir`). @default "./src" */
  srcDir?: string;
  /** Build output directory (waku's `distDir`). @default "./dist" */
  outDir?: string;
  /** Public base path the site deploys under (waku's `basePath`). */
  basePath?: string;
}

/**
 * Deploy a [Waku](https://waku.gg) application to AWS: the RSC server on a
 * streaming Lambda Function URL, static assets (SSG pages included) in S3,
 * and a CloudFront distribution whose edge router serves uploaded files
 * from S3 and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/waku` with the
 * `@alchemy.run/frontend-frameworks/waku/aws` deploy target (this package's fork
 * of waku's aws-lambda adapter, streaming enabled) — both must be installed
 * in your project.
 *
 * ### Creating Waku Sites
 * **Example:** Basic Waku App
 * ```typescript
 * const site = yield* AWS.Website.Waku("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Waku("Web", {
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
 * const site = yield* AWS.Website.Waku("Web", {
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
export const Waku = (id: string, props: InputProps<WakuProps> = {}) => {
  const p = props as WakuProps;
  const waku = {
    srcDir: p.srcDir,
    distDir: p.outDir,
    basePath: p.basePath,
  };
  return makeFrameworkSite(id, props, {
    name: "Waku",
    framework: WAKU_FRAMEWORK_SPECIFIER,
    target: WAKU_AWS_TARGET_SPECIFIER,
    options:
      p.srcDir !== undefined ||
      p.outDir !== undefined ||
      p.basePath !== undefined
        ? { waku }
        : undefined,
  }).pipe(Namespace.push(id));
};
