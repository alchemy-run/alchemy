import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import * as Command from "../../Command/index.ts";
import { toPath } from "../../FQN.ts";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { Certificate } from "../ACM/Certificate.ts";
import { CachePolicy } from "../CloudFront/CachePolicy.ts";
import { Distribution } from "../CloudFront/Distribution.ts";
import { Function as CloudFrontFunction } from "../CloudFront/Function.ts";
import { Invalidation } from "../CloudFront/Invalidation.ts";
import { KeyValueStore } from "../CloudFront/KeyValueStore.ts";
import { KvEntries } from "../CloudFront/KvEntries.ts";
import { KvRoutesUpdate } from "../CloudFront/KvRoutesUpdate.ts";
import {
  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
  MANAGED_CACHING_OPTIMIZED_POLICY_ID,
} from "../CloudFront/ManagedPolicies.ts";
import { OriginAccessControl } from "../CloudFront/OriginAccessControl.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { Record as Route53Record } from "../Route53/Record.ts";
import { Bucket } from "../S3/Bucket.ts";
import type { AssetFileOption } from "./AssetDeployment.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import {
  CF_BLOCK_CLOUDFRONT_URL_INJECTION,
  CF_ROUTER_INJECTION,
} from "./cfcode.ts";
import type {
  StaticSiteAssetsProps,
  StaticSiteBuildProps,
  WebsiteDomainProps,
  WebsiteEdgeProps,
  WebsiteInvalidationProps,
} from "./shared.ts";

type StaticSiteDomainInput = string | WebsiteDomainProps;

export interface StaticSiteRouterAttachment {
  /**
   * The `AWS.Website.Router` to attach to (or its KV store, namespace,
   * distribution ID, and URL outputs).
   */
  instance: {
    kvStoreArn: Input<string>;
    kvNamespace: Input<string>;
    distributionId: Input<string>;
    distributionArn: Input<string>;
    url: Input<string>;
  };
  /**
   * Optional host pattern this site should be served for (e.g.
   * `docs.example.com` or `*.example.com`). When omitted, the site matches
   * any host on the router.
   */
  domain?: string;
  /**
   * Path prefix the site is served under (e.g. `/docs`).
   * @default "/"
   */
  path?: string;
}

export interface StaticSiteProps {
  /**
   * Path to the local site directory.
   * @default "."
   */
  path?: Input<string>;
  /**
   * Optional build configuration executed before upload.
   */
  build?: StaticSiteBuildProps;
  /**
   * Environment variables exposed to the build command.
   */
  environment?: Record<string, Input<string>>;
  /**
   * Static site asset upload configuration.
   */
  assets?: StaticSiteAssetsProps & {
    fileOptions?: AssetFileOption[];
  };
  /**
   * Optional custom domain.
   */
  domain?: StaticSiteDomainInput;
  /**
   * Serve this site through an existing Router instead of creating a standalone
   * CloudFront distribution.
   */
  router?: StaticSiteRouterAttachment;
  /**
   * Additional CloudFront Function customizations.
   */
  edge?: WebsiteEdgeProps;
  /**
   * Index page served for the site root.
   * @default "index.html"
   */
  indexPage?: string;
  /**
   * Serve this site as a single-page application: any request that does not
   * match an uploaded file is answered with the `indexPage` and a `200`
   * status so client-side routing can take over.
   *
   * This is also the fallback behavior when neither `spa` nor `errorPage`
   * is set. Setting `spa: true` makes the intent explicit and guards
   * against accidentally combining it with `errorPage`.
   *
   * Mutually exclusive with `errorPage` (a static site returns a real
   * `404`; a SPA serves the app shell).
   * @default false
   */
  spa?: boolean;
  /**
   * Error page returned for 403/404 requests.
   * When set, CloudFront customErrorResponses are created and misses return
   * a real `404` status. Mutually exclusive with `spa`.
   */
  errorPage?: string;
  /**
   * Optional deterministic S3 bucket name for newly created buckets.
   */
  bucketName?: string;
  /**
   * Whether to delete uploaded objects before destroying created buckets.
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
 * Deploy a static website to S3 and CloudFront using KV-based edge routing.
 *
 * `StaticSite` uploads site files to a private S3 bucket, creates a CloudFront
 * KeyValueStore with a file manifest for edge routing, and optionally builds
 * the site first. Supports standalone distribution or composition with
 * `AWS.Website.Router`.
 * @resource
 * @section Basic Sites
 * @example Simple Static Site
 * ```typescript
 * const site = yield* StaticSite("Docs", {
 *   path: "./site",
 * });
 * ```
 *
 * @section Built Sites
 * @example Build A Vite App
 * ```typescript
 * const site = yield* StaticSite("Web", {
 *   path: "./frontend",
 *   build: {
 *     command: "bun run build",
 *     output: "dist",
 *   },
 *   environment: {
 *     VITE_API_URL: api.url,
 *   },
 * });
 * ```
 *
 * @section Single-Page Applications
 * @example SPA With Client-Side Routing
 * ```typescript
 * // Misses fall back to index.html with a 200 so the client router
 * // can handle the path.
 * const site = yield* StaticSite("App", {
 *   path: "./app",
 *   build: {
 *     command: "bun run build",
 *     output: "dist",
 *   },
 *   spa: true,
 * });
 * ```
 *
 * @section Custom Domains
 * @example Site With A Route 53 Domain
 * ```typescript
 * const site = yield* StaticSite("Web", {
 *   path: "./site",
 *   domain: {
 *     name: "www.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 *   errorPage: "404.html",
 * });
 * ```
 *
 * @section Router Composition
 * @example Serve Through A Router
 * ```typescript
 * const site = yield* StaticSite("Docs", {
 *   path: "./docs",
 *   router: {
 *     instance: router,
 *     path: "/docs",
 *   },
 * });
 * ```
 */
export const StaticSite = (id: string, props: StaticSiteProps) =>
  makeKvSite(id, props).pipe(Namespace.push(id));

/**
 * Dynamic server origin for {@link makeKvSite} — the KV metadata gains a
 * `servers` entry so requests that match no uploaded file are forwarded to
 * the server instead of a static fallback.
 * @internal
 */
export interface KvSiteServerOptions {
  /**
   * Hostname of the dynamic server origin (e.g. a Lambda Function URL
   * host). Requests that miss the file manifest are forwarded here with
   * `x-forwarded-host` set.
   */
  serverHost: Input<string>;
}

/**
 * Shared implementation behind `StaticSite` and the SSR framework
 * composites (`AWS.Website.Nuxt`, ...): S3 + CloudFront + KV-manifest edge
 * routing, optionally with a dynamic server origin for misses.
 * @internal
 */
export const makeKvSite = (
  id: string,
  props: StaticSiteProps,
  server?: KvSiteServerOptions,
) =>
  Effect.gen(function* () {
    const domain = normalizeDomain(props.domain);
    const sitePath = (props.path ?? ".") as string;
    const indexPage = props.indexPage ?? "index.html";
    const assetPrefix = normalizePrefix(props.assets?.path);
    const assetRoutes = [...(props.assets?.routes ?? [])]
      .map((value) => value.trim())
      .filter(Boolean)
      .map(normalizeRoutePath);
    const invalidationProps =
      props.invalidation !== undefined
        ? props.invalidation
        : { paths: "all" as const, wait: false };

    if (props.router && props.domain) {
      return yield* Effect.die(
        `Cannot provide both "domain" and "router". Use the "domain" prop on the Router component.`,
      );
    }
    if (props.router && props.edge) {
      return yield* Effect.die(
        `Cannot provide both "edge" and "router". Use the "edge" prop on the Router component.`,
      );
    }
    if (props.spa && props.errorPage) {
      return yield* Effect.die(
        `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page (200); "errorPage" answers them with a real 404.`,
      );
    }
    if (server && (props.spa || props.errorPage)) {
      return yield* Effect.die(
        `A site with a server origin routes misses to the server; "spa" and "errorPage" do not apply.`,
      );
    }

    const build = props.build
      ? yield* Command.Build("Build", {
          command: props.build.command,
          cwd: sitePath,
          memo: {
            include: props.build.include,
            exclude: props.build.exclude,
            lockfile: props.build.lockfile,
          },
          outdir: props.build.output,
          env: props.environment,
        })
      : undefined;

    const uploadSourcePath = (build?.outdir ?? sitePath) as string;

    const providedBucket = props.assets?.bucket;
    const bucket =
      providedBucket ??
      (yield* Bucket("Bucket", {
        bucketName: props.bucketName,
        forceDestroy: props.forceDestroy,
        tags: props.tags,
      }));

    const routerAttachment = props.router;
    const routerPathPrefix = routerAttachment?.path
      ? "/" + routerAttachment.path.replace(/^\//, "").replace(/\/$/, "")
      : undefined;

    const files = yield* AssetDeployment("Files", {
      bucket: bucket,
      sourcePath: uploadSourcePath,
      prefix: normalizeUploadPrefix(assetPrefix, routerPathPrefix),
      purge: props.assets?.purge ?? true,
      fileOptions: props.assets?.fileOptions,
      textEncoding: props.assets?.textEncoding,
    });

    const stack = yield* Stack;
    const stage = yield* Stage;
    const ns = yield* Namespace.CurrentNamespace;
    const fqn = ns ? toPath(ns).join("/") : id;
    const kvNamespace = createHash("md5")
      .update(`${stack.name}-${stage}-${fqn}`)
      .digest("hex")
      .substring(0, 4);

    // Standalone distributions carry the asset prefix as the default
    // origin's `originPath` (so error-page fetches that bypass the edge
    // function still resolve); router-attached sites prefix at the edge via
    // the KV metadata instead.
    const s3MetadataDir =
      routerAttachment && assetPrefix ? "/" + assetPrefix : "";

    const kvEntries = buildKvEntries({
      files,
      bucketDomain: bucket.bucketRegionalDomainName as Input<string>,
      s3Dir: s3MetadataDir,
      assetRoutes,
      indexPage,
      errorPage: props.errorPage,
      routerPathPrefix,
      serverHost: server?.serverHost,
    });

    let distributionId: Input<string>;
    let kvStoreArn: Input<string>;
    let distribution: Distribution | undefined;
    let prodUrl: Input<string> | undefined;

    if (routerAttachment) {
      kvStoreArn = routerAttachment.instance.kvStoreArn;
      distributionId = routerAttachment.instance.distributionId;
      const hostPattern = routerAttachment.domain
        ? routerAttachment.domain
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
        : undefined;
      yield* KvRoutesUpdate("RoutesUpdate", {
        store: kvStoreArn,
        namespace: routerAttachment.instance.kvNamespace as any,
        key: "routes",
        entry: [
          "site",
          kvNamespace,
          hostPattern ?? "",
          routerPathPrefix ?? "/",
        ].join(","),
      });
      prodUrl = routerAttachment.domain
        ? `https://${routerAttachment.domain}${routerPathPrefix ?? ""}`
        : Output.interpolate`${routerAttachment.instance.url}${routerPathPrefix ?? ""}`;
    } else {
      if (
        domain &&
        !domain.cert &&
        !domain.hostedZoneId &&
        domain.dns === false
      ) {
        return yield* Effect.die(
          "StaticSite domain configuration with `dns: false` requires `cert`.",
        );
      }

      const certificate =
        !domain || domain.cert
          ? domain?.cert
            ? { certificateArn: domain.cert }
            : undefined
          : yield* Certificate("Certificate", {
              domainName: domain.name,
              subjectAlternativeNames: [
                ...(domain.aliases ?? []),
                ...(domain.redirects ?? []),
              ],
              hostedZoneId: domain.hostedZoneId,
              tags: props.tags,
            });

      const kvStore = yield* KeyValueStore("KvStore", {});
      kvStoreArn = kvStore.keyValueStoreArn;

      const viewerRequest = yield* CloudFrontFunction("ViewerRequest", {
        comment: `${id} viewer request`,
        code: buildRequestFunctionCode({
          kvNamespace,
          userInjection: props.edge?.viewerRequest?.injection,
          blockCloudfrontUrl: !!domain,
        }),
        keyValueStoreArns: [kvStore.keyValueStoreArn],
      });

      const viewerResponse = props.edge?.viewerResponse
        ? yield* CloudFrontFunction("ViewerResponse", {
            comment: `${id} viewer response`,
            code: buildResponseFunctionCode(
              props.edge.viewerResponse.injection,
            ),
            keyValueStoreArns: props.edge.viewerResponse.keyValueStoreArn
              ? [props.edge.viewerResponse.keyValueStoreArn]
              : undefined,
          })
        : undefined;

      const functionAssociations = [
        {
          eventType: "viewer-request" as const,
          functionArn: viewerRequest.functionArn,
        },
        ...(viewerResponse
          ? [
              {
                eventType: "viewer-response" as const,
                functionArn: viewerResponse.functionArn,
              },
            ]
          : []),
      ];

      const errorPage = "/" + (props.errorPage ?? indexPage).replace(/^\//, "");
      const customErrorResponses =
        props.errorPage && !server
          ? [
              {
                ErrorCode: 403,
                ResponseCode: "404",
                ResponsePagePath: errorPage,
                ErrorCachingMinTTL: 0,
              },
              {
                ErrorCode: 404,
                ResponseCode: "404",
                ResponsePagePath: errorPage,
                ErrorCachingMinTTL: 0,
              },
            ]
          : undefined;

      // Server-backed sites share one behavior between S3 assets and the
      // dynamic origin, so the cache policy must not cache responses that
      // carry no Cache-Control (SSR pages) while still honoring the
      // immutable Cache-Control the asset uploader sets. Managed
      // CachingOptimized would cache header-less SSR responses for a day.
      const serverCachePolicy = server
        ? yield* CachePolicy("ServerCachePolicy", {
            comment: `${id} server cache policy`,
            minTTL: 0,
            defaultTTL: 0,
            maxTTL: "365 days",
            parametersInCacheKeyAndForwardedToOrigin: {
              EnableAcceptEncodingGzip: true,
              EnableAcceptEncodingBrotli: true,
              QueryStringsConfig: { QueryStringBehavior: "all" },
              HeadersConfig: { HeaderBehavior: "none" },
              CookiesConfig: { CookieBehavior: "none" },
            },
          })
        : undefined;

      // The default origin is real (not a placeholder): static sites point
      // at the bucket through an OAC so requests that bypass the edge
      // function's origin switch — CloudFront's custom-error-page fetches
      // in particular — still resolve; server-backed sites point at the
      // server so misses stream from it even if the function is bypassed.
      const oac = server
        ? undefined
        : yield* OriginAccessControl("OriginAccessControl", {
            originType: "s3",
            description: `${id} origin access control`,
          });

      distribution = yield* Distribution("Distribution", {
        aliases: domain
          ? [
              domain.name,
              ...(domain.aliases ?? []),
              ...(domain.redirects ?? []),
            ]
          : undefined,
        origins: [
          server
            ? {
                id: "default",
                domainName: server.serverHost,
                customOriginConfig: {
                  httpPort: 80,
                  httpsPort: 443,
                  originProtocolPolicy: "https-only" as const,
                  originReadTimeout: "20 seconds",
                  originSslProtocols: ["TLSv1.2"],
                },
              }
            : {
                id: "default",
                domainName: bucket.bucketRegionalDomainName,
                s3Origin: true,
                originAccessControlId: oac!.originAccessControlId,
                originPath: assetPrefix ? "/" + assetPrefix : undefined,
              },
        ],
        defaultCacheBehavior: {
          targetOriginId: "default",
          viewerProtocolPolicy: "redirect-to-https",
          allowedMethods: [
            "DELETE",
            "GET",
            "HEAD",
            "OPTIONS",
            "PATCH",
            "POST",
            "PUT",
          ],
          cachedMethods: ["GET", "HEAD"],
          compress: true,
          cachePolicyId: serverCachePolicy
            ? serverCachePolicy.cachePolicyId
            : MANAGED_CACHING_OPTIMIZED_POLICY_ID,
          originRequestPolicyId: server
            ? MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID
            : undefined,
          functionAssociations,
        },
        customErrorResponses,
        viewerCertificate: certificate
          ? {
              acmCertificateArn: certificate.certificateArn,
              sslSupportMethod: "sni-only",
              minimumProtocolVersion: "TLSv1.2_2021",
            }
          : undefined,
        tags: props.tags,
      });

      const dist = distribution;
      distributionId = dist.distributionId;

      if (domain?.hostedZoneId && domain.dns !== false) {
        yield* Effect.forEach(
          [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])],
          (name, index) =>
            Route53Record(`AliasRecord${index + 1}`, {
              hostedZoneId: domain.hostedZoneId!,
              name,
              type: "A",
              aliasTarget: {
                hostedZoneId: dist.hostedZoneId,
                dnsName: dist.domainName,
              },
            }),
          { concurrency: "unbounded" },
        );
      }

      prodUrl = domain
        ? Output.interpolate`https://${domain.name}`
        : Output.interpolate`https://${dist.domainName}`;
    }

    // The edge router signs S3 origin requests with OAC (sigv4, see
    // `setS3Origin` in cfcode.ts), so the bucket must allow the serving
    // distribution — without this policy every request 403s.
    const servingDistributionArn = routerAttachment
      ? routerAttachment.instance.distributionArn
      : distribution!.distributionArn;
    const bucketPolicy: PolicyStatement = {
      Effect: "Allow",
      Principal: {
        Service: "cloudfront.amazonaws.com",
      },
      Action: ["s3:GetObject"],
      Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
      Condition: {
        StringEquals: {
          "AWS:SourceArn": servingDistributionArn as any,
        },
      },
    };
    yield* bucket.bind`AWS.S3.Policy(CloudFront, ${bucket})`({
      policyStatements: [bucketPolicy],
    });

    yield* KvEntries("KvEntries", {
      store: kvStoreArn,
      namespace: kvNamespace,
      entries: kvEntries,
      purge: props.assets?.purge ?? true,
    });

    const invalidation =
      invalidationProps === false
        ? undefined
        : yield* Invalidation("Invalidation", {
            distributionId: distributionId,
            version: files.version,
            wait: invalidationProps?.wait,
            paths:
              invalidationProps?.paths === "all" || !invalidationProps?.paths
                ? ["/*"]
                : invalidationProps.paths === "versioned"
                  ? [`/${indexPage.replace(/^\/+/, "")}`]
                  : invalidationProps.paths,
          });

    return {
      bucket: bucket,
      build,
      files,
      distribution,
      invalidation,
      kvNamespace,
      url: prodUrl,
    };
  });

/**
 * Derive the CloudFront KV routing entries from the *uploaded* file list
 * (the `AssetDeployment`'s `files` attribute) so the manifest always
 * reflects exactly what landed in S3 — including build outputs that do not
 * exist at plan time.
 */
const buildKvEntries = (args: {
  files: { files: Output.Output<string[]> };
  bucketDomain: Input<string>;
  s3Dir: string;
  assetRoutes: string[];
  indexPage: string;
  errorPage: string | undefined;
  routerPathPrefix: string | undefined;
  serverHost: Input<string> | undefined;
}): Input<Record<string, string>> =>
  Output.map(
    ([fileList, bucketDomain, serverHost]: [
      string[] | undefined,
      string,
      string | undefined,
    ]) => {
      const entries: Record<string, string> = {};
      for (const file of fileList ?? []) {
        entries[`/${file}`] = "s3";
      }
      const errorPagePath =
        "/" + (args.errorPage ?? args.indexPage).replace(/^\//, "");
      const metadata: KvSiteMetadata = {
        base:
          args.routerPathPrefix && args.routerPathPrefix !== "/"
            ? args.routerPathPrefix
            : undefined,
        custom404:
          serverHost !== undefined || args.errorPage
            ? undefined
            : errorPagePath,
        errorResponseCode:
          serverHost === undefined && args.errorPage ? 404 : undefined,
        s3: {
          domain: bucketDomain,
          dir: args.s3Dir,
          routes: args.assetRoutes,
        },
        servers: serverHost !== undefined ? [[serverHost]] : undefined,
      };
      entries["metadata"] = JSON.stringify(metadata);
      return entries;
    },
  )(
    Output.all(
      args.files.files,
      Output.asOutput(args.bucketDomain as any),
      Output.asOutput(args.serverHost as any),
    ) as Output.Output<[string[] | undefined, string, string | undefined]>,
  );

interface KvSiteMetadata {
  base?: string | undefined;
  custom404?: string | undefined;
  errorResponseCode?: number | undefined;
  s3: {
    domain: string;
    dir: string;
    routes: string[];
  };
  /**
   * Server origin hosts (`[[host, lat?, lon?], ...]`) the edge router
   * forwards misses to — see `findNearestServer` in cfcode.ts.
   */
  servers?: Array<Array<string>> | undefined;
}

const buildRequestFunctionCode = ({
  kvNamespace,
  userInjection,
  blockCloudfrontUrl,
}: {
  kvNamespace: string;
  userInjection?: string;
  blockCloudfrontUrl: boolean;
}) => `import cf from "cloudfront";
async function handler(event) {
  ${userInjection ?? ""}
  ${blockCloudfrontUrl ? CF_BLOCK_CLOUDFRONT_URL_INJECTION : ""}
  ${CF_ROUTER_INJECTION}

  const kvNamespace = "${kvNamespace}";

  let metadata;
  try {
    const v = await cf.kvs().get(kvNamespace + ":metadata");
    metadata = JSON.parse(v);
  } catch (e) {}

  const response = await routeSite(kvNamespace, metadata);
  return response || event.request;
}`;

const buildResponseFunctionCode = (
  userInjection?: string,
) => `import cf from "cloudfront";
async function handler(event) {
  ${userInjection ?? ""}
  return event.response;
}`;

const normalizePrefix = (prefix: string | undefined) =>
  prefix ? prefix.replace(/^\/+|\/+$/g, "") : "";

const normalizeUploadPrefix = (
  assetPrefix: string,
  routerPathPrefix: string | undefined,
) => {
  const parts = [assetPrefix, routerPathPrefix?.replace(/^\//, "")].filter(
    Boolean,
  );
  return parts.join("/") || "";
};

const normalizeRoutePath = (value: string) =>
  `/${value.replace(/^\/+|\/+$/g, "")}`;

const normalizeDomain = (
  domain: StaticSiteProps["domain"],
): WebsiteDomainProps | undefined =>
  typeof domain === "string" ? { name: domain } : domain;
