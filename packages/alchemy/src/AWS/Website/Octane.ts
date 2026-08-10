import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import { Function as LambdaFunction } from "../Lambda/Function.ts";
import type { AssetFileOption } from "./AssetDeployment.ts";
import { Server } from "./Server.ts";
import {
  makeKvSite,
  type StaticSiteProps,
  type StaticSiteRouterAttachment,
} from "./StaticSite.ts";
import type {
  StaticSiteAssetsProps,
  WebsiteDomainProps,
  WebsiteEdgeProps,
  WebsiteInvalidationProps,
} from "./shared.ts";

/** The framework-integration package that drives the Octane build. */
export const OCTANE_FRAMEWORK_SPECIFIER = "@alchemy.run/web-frameworks/octane";

/** The AWS Lambda deploy target for the Octane build. */
export const OCTANE_AWS_TARGET_SPECIFIER =
  "@alchemy.run/web-frameworks/octane/aws";

export interface OctaneProps {
  /**
   * Project root directory (the directory containing `vite.config.ts` and
   * `octane.config.ts`).
   * @default "."
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * SSR server (Lambda) configuration.
   */
  server?: {
    /**
     * Memory allocated to the server function, in MB.
     * @default 1024
     */
    memorySize?: number;
    /**
     * Maximum request duration.
     * @default 30 seconds
     */
    timeout?: Duration.Duration;
    /**
     * Environment variables for the server function.
     */
    environment?: Record<string, any>;
    /**
     * Instruction set architecture.
     * @default "x86_64"
     */
    architecture?: "x86_64" | "arm64";
  };
  /**
   * Static asset upload configuration.
   */
  assets?: StaticSiteAssetsProps & {
    fileOptions?: AssetFileOption[];
  };
  /**
   * Optional custom domain.
   */
  domain?: string | WebsiteDomainProps;
  /**
   * Serve this site through an existing `AWS.Website.Router` instead of a
   * standalone CloudFront distribution.
   */
  router?: StaticSiteRouterAttachment;
  /**
   * Additional CloudFront Function customizations.
   */
  edge?: WebsiteEdgeProps;
  /**
   * Optional deterministic S3 bucket name for the asset bucket.
   */
  bucketName?: string;
  /**
   * Whether to delete uploaded objects when the bucket is destroyed.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * CloudFront invalidation behavior.
   * @default { paths: "all", wait: false }
   */
  invalidation?: false | WebsiteInvalidationProps;
  /**
   * User-defined tags applied to created resources.
   */
  tags?: Record<string, string>;
}

/**
 * Deploy an [OctaneJS](https://octanejs.dev) application to AWS: Octane's
 * SSR server on a streaming Lambda Function URL, static assets in S3, and a
 * CloudFront distribution whose edge router serves uploaded files from S3
 * and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/web-frameworks/octane` with the
 * `@alchemy.run/web-frameworks/octane/aws` deploy target — the project's
 * own `vite build` (with `@octanejs/vite-plugin`) produces the
 * self-contained node server bundle, and the target's finishing pass wraps
 * its fetch handler as a streaming Lambda handler. The project's
 * `octane.config.ts` must select the AWS marker adapter:
 *
 * ```ts
 * import { aws } from "@alchemy.run/web-frameworks/octane/aws-adapter";
 * import { defineConfig } from "@octanejs/vite-plugin";
 *
 * export default defineConfig({
 *   adapter: aws(),
 *   // ...
 * });
 * ```
 *
 * @resource
 * @section Creating Octane Sites
 * @example Basic Octane App
 * ```typescript
 * const site = yield* AWS.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * @example Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Octane("Web", {
 *   rootDir: "./app",
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * @section Server Configuration
 * @example Tune The Server Function
 * ```typescript
 * const site = yield* AWS.Website.Octane("Web", {
 *   rootDir: "./app",
 *   server: {
 *     memorySize: 2048,
 *     environment: {
 *       API_BASE: api.url,
 *     },
 *   },
 * });
 * ```
 */
export const Octane = (id: string, props: OctaneProps = {}) =>
  Effect.gen(function* () {
    const ctx = yield* AlchemyContext;
    const remoted = yield* ProviderModePolicy;
    // Mirrors the Cloudflare Website composites: during `alchemy dev` the
    // site is the framework's own dev server (native HMR) and no cloud
    // resources are declared; `Alchemy.remote()` opts back into the full
    // live deployment.
    const isLocal = ctx.dev && remoted !== true;

    const build = yield* Server("Build", {
      framework: OCTANE_FRAMEWORK_SPECIFIER,
      target: OCTANE_AWS_TARGET_SPECIFIER,
      root: props.rootDir,
      memo: props.memo,
    });

    if (isLocal) {
      return {
        bucket: undefined,
        build,
        files: undefined,
        distribution: undefined,
        invalidation: undefined,
        kvNamespace: undefined,
        server: undefined,
        serverUrl: undefined,
        url: build.url,
      };
    }

    const server = yield* LambdaFunction("Server", {
      main: build.serverEntry as unknown as string,
      handler: "handler",
      isExternal: true,
      // Octane's `dist/server` is a complete deployment unit (the emitted
      // Lambda entry + Octane's self-contained node bundle + the SSR HTML
      // template it reads at boot) — ship it as-is.
      bundle: false,
      runtime: "nodejs22.x",
      architecture: props.server?.architecture,
      memorySize: props.server?.memorySize ?? 1024,
      timeout: props.server?.timeout ?? Duration.seconds(30),
      env: props.server?.environment,
      url: {
        authType: "NONE",
        invokeMode: "RESPONSE_STREAM",
      },
    });

    const serverHost = Output.map((url: string | undefined) => {
      if (!url) {
        throw new Error(
          "The Octane server function did not produce a Function URL.",
        );
      }
      return new URL(url).hostname;
    })(server.functionUrl as any) as Input<string>;

    const siteProps: StaticSiteProps = {
      path: build.clientDir as unknown as string,
      assets: props.assets,
      domain: props.domain,
      router: props.router,
      edge: props.edge,
      bucketName: props.bucketName,
      forceDestroy: props.forceDestroy,
      invalidation: props.invalidation,
      tags: props.tags,
    };

    const site = yield* makeKvSite(id, siteProps, { serverHost });

    return {
      ...site,
      build,
      server,
      serverUrl: server.functionUrl,
    };
  }).pipe(Namespace.push(id));
