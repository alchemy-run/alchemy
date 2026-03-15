import * as Effect from "effect/Effect";
import { Build } from "../../Build/Build.ts";
import * as Construct from "../../Construct.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { Certificate } from "../ACM/Certificate.ts";
import { Distribution } from "../CloudFront/Distribution.ts";
import { Function as CloudFrontFunction } from "../CloudFront/Function.ts";
import { Invalidation } from "../CloudFront/Invalidation.ts";
import { MANAGED_CACHING_OPTIMIZED_POLICY_ID } from "../CloudFront/ManagedPolicies.ts";
import { OriginAccessControl } from "../CloudFront/OriginAccessControl.ts";
import { Record as Route53Record } from "../Route53/Record.ts";
import { Bucket } from "../S3/Bucket.ts";
import type { AssetFileOption } from "./AssetDeployment.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import type {
  StaticSiteAssetsProps,
  StaticSiteBuildProps,
  StaticSiteRouteTarget,
  StaticSiteRouterProps,
  WebsiteDomainProps,
  WebsiteEdgeProps,
  WebsiteInvalidationProps,
} from "./shared.ts";

type StaticSiteDomainInput = string | WebsiteDomainProps;

export interface StaticSiteProps {
  /**
   * Path to the local site directory.
   * @default "."
   */
  path?: Input<string>;
  /**
   * Deprecated alias for `path` or a prebuilt directory to upload.
   */
  sourcePath?: Input<string>;
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
   * Path metadata used when composing the site with a router.
   */
  router?: StaticSiteRouterProps;
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
   * Error page returned for 403/404 requests.
   * When omitted and `spa` is true, this defaults to `indexPage`.
   */
  errorPage?: string;
  /**
   * Whether to configure SPA-style 403/404 rewrites to the index page.
   * @default false
   */
  spa?: boolean;
  /**
   * Deprecated alias for `indexPage`.
   */
  defaultRootObject?: string;
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
   * Deprecated alias for `assets.path`.
   */
  prefix?: string;
  /**
   * Deprecated alias for `assets.purge`.
   */
  purge?: boolean;
  /**
   * Deprecated alias for `assets.fileOptions`.
   */
  fileOptions?: AssetFileOption[];
  /**
   * Deprecated boolean invalidation flag.
   */
  invalidate?: boolean;
  /**
   * CloudFront invalidation behavior.
   * @default { paths: "all", wait: false }
   */
  invalidation?: false | WebsiteInvalidationProps;
  /**
   * Whether to create a standalone CloudFront distribution for the site.
   * Set this to `false` when composing the site manually with `routeTarget`.
   * @default true
   */
  cdn?: boolean;
  /**
   * User-defined tags applied to created resources.
   */
  tags?: Record<string, string>;
}

const buildViewerRequestCode = ({
  indexPage,
  assetRoutes,
  redirectPrimaryDomain,
  redirectHosts,
  userInjection,
}: {
  indexPage: string;
  assetRoutes: string[];
  redirectPrimaryDomain?: string;
  redirectHosts: string[];
  userInjection?: string;
}) => `async function handler(event) {
  const request = event.request;
  const host = request.headers.host?.value ?? "";
  const uri = request.uri || "/";
  const assetRoutes = ${JSON.stringify(assetRoutes)};
  const redirectHosts = ${JSON.stringify(redirectHosts)};

${userInjection ? `  ${userInjection}\n` : ""}  if (${redirectPrimaryDomain ? "redirectHosts.includes(host)" : "false"}) {
    const toQueryString = (query) => {
      const parts = [];
      for (const [key, value] of Object.entries(query || {})) {
        if (value && typeof value === "object" && "multiValue" in value) {
          for (const item of value.multiValue || []) {
            parts.push(\`\${encodeURIComponent(key)}=\${encodeURIComponent(item.value ?? "")}\`);
          }
          continue;
        }
        parts.push(\`\${encodeURIComponent(key)}=\${encodeURIComponent(value?.value ?? "")}\`);
      }
      return parts.length > 0 ? \`?\${parts.join("&")}\` : "";
    };

    return {
      statusCode: 308,
      statusDescription: "Permanent Redirect",
      headers: {
        location: {
          value: "https://${redirectPrimaryDomain ?? ""}" + uri + toQueryString(request.querystring),
        },
      },
    };
  }

  const isAssetRoute = assetRoutes.some((route) => uri === route || uri.startsWith(route + "/"));
  if (!isAssetRoute) {
    if (uri.endsWith("/")) {
      request.uri = uri + ${JSON.stringify(indexPage.replace(/^\/+/, ""))};
    } else {
      const lastSegment = uri.split("/").pop() ?? "";
      if (!lastSegment.includes(".")) {
        request.uri = uri + ".html";
      }
    }
  }

  return request;
}
`;

const buildViewerResponseCode = (
  userInjection?: string,
) => `async function handler(event) {
  const response = event.response;
${userInjection ? `  ${userInjection}\n` : ""}  return response;
}
`;

/**
 * Deploy a static website to S3 and CloudFront.
 *
 * `StaticSite` uploads site files to a private S3 bucket, serves them through
 * CloudFront, can optionally build the site first, and returns a `routeTarget`
 * for manual composition with `AWS.Website.Router`.
 *
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
 * @section Router Composition
 * @example Return A Route Target
 * ```typescript
 * const site = yield* StaticSite("Docs", {
 *   path: "./docs",
 *   cdn: false,
 * });
 *
 * yield* Router("WebRouter", {
 *   routes: {
 *     "/docs*": site.routeTarget,
 *   },
 * });
 * ```
 */
export const StaticSite = Construct.fn(function* (
  id: string,
  props: StaticSiteProps,
) {
  const domain = normalizeDomain(props.domain);
  const path = props.path ?? props.sourcePath ?? ".";
  const indexPage = props.indexPage ?? props.defaultRootObject ?? "index.html";
  const errorPage = props.errorPage ?? (props.spa ? indexPage : undefined);
  const assetPrefix = normalizePrefix(props.assets?.path ?? props.prefix);
  const assetRoutes = [...(props.assets?.routes ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeRoutePath);
  const invalidationProps =
    props.invalidation !== undefined
      ? props.invalidation
      : props.invalidate === false
        ? false
        : {
            paths: "all" as const,
            wait: false,
          };

  const build = props.build
    ? yield* Build("Build", {
        command: props.build.command,
        cwd: path as any,
        include: (props.build as StaticSiteBuildProps & { include?: string[] })
          .include ?? ["**/*"],
        exclude: [
          ...((props.build as StaticSiteBuildProps & { exclude?: string[] })
            .exclude ?? []),
          `**/${props.build.output}/**`,
          "**/node_modules/**",
          "**/.git/**",
        ],
        output: props.build.output,
        env: props.environment as any,
      })
    : undefined;

  const uploadSourcePath = build?.path ?? path;

  const providedBucket = props.assets?.bucket;
  const bucket =
    providedBucket ??
    (yield* Bucket("Bucket", {
      bucketName: props.bucketName,
      forceDestroy: props.forceDestroy,
      tags: props.tags,
    }));

  const files = yield* AssetDeployment("Files", {
    bucket: bucket,
    sourcePath: uploadSourcePath as any,
    prefix: assetPrefix,
    purge: props.assets?.purge ?? props.purge ?? true,
    fileOptions: props.assets?.fileOptions ?? props.fileOptions,
    textEncoding: props.assets?.textEncoding,
  });

  const oac = yield* OriginAccessControl("OriginAccessControl", {
    originType: "s3",
    description: `${id} static site origin access control`,
  });

  const routeTarget: StaticSiteRouteTarget = {
    bucket: bucket as any,
    originAccessControlId: oac.originAccessControlId,
    originPath: assetPrefix ? `/${assetPrefix}` : undefined,
    defaultRootObject: indexPage,
    spa: props.spa,
    version: files.version,
  };

  if (props.cdn === false) {
    return {
      bucket: bucket as any,
      build,
      files,
      originAccessControl: oac,
      certificate: undefined,
      distribution: undefined,
      records: [],
      invalidation: undefined,
      routeTarget,
      url: undefined,
    };
  }

  if (domain && !domain.cert && !domain.hostedZoneId && domain.dns === false) {
    return yield* Effect.fail(
      new Error(
        "StaticSite domain configuration with `dns: false` requires `cert`.",
      ),
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

  const viewerRequest = yield* CloudFrontFunction("ViewerRequest", {
    comment: `${id} viewer request`,
    code: buildViewerRequestCode({
      indexPage,
      assetRoutes,
      redirectPrimaryDomain: domain?.name,
      redirectHosts: domain?.redirects ?? [],
      userInjection: props.edge?.viewerRequest?.injection,
    }),
    keyValueStoreArns: props.edge?.viewerRequest?.keyValueStoreArn
      ? [props.edge.viewerRequest.keyValueStoreArn as any]
      : undefined,
  });

  const viewerResponse = props.edge?.viewerResponse
    ? yield* CloudFrontFunction("ViewerResponse", {
        comment: `${id} viewer response`,
        code: buildViewerResponseCode(props.edge.viewerResponse.injection),
        keyValueStoreArns: props.edge.viewerResponse.keyValueStoreArn
          ? [props.edge.viewerResponse.keyValueStoreArn as any]
          : undefined,
      })
    : undefined;

  const functionAssociations = [
    {
      eventType: "viewer-request" as const,
      functionArn: viewerRequest.functionArn as any,
    },
    ...(viewerResponse
      ? [
          {
            eventType: "viewer-response" as const,
            functionArn: viewerResponse.functionArn as any,
          },
        ]
      : []),
  ];

  const distribution = yield* Distribution("Distribution", {
    aliases: domain
      ? [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])]
      : undefined,
    defaultRootObject: indexPage,
    origins: [
      {
        id: "site",
        domainName: bucket.bucketRegionalDomainName,
        originPath: assetPrefix ? `/${assetPrefix}` : undefined,
        s3Origin: true,
        originAccessControlId: oac.originAccessControlId,
      },
    ],
    defaultCacheBehavior: {
      targetOriginId: "site",
      viewerProtocolPolicy: "redirect-to-https",
      compress: true,
      allowedMethods: ["GET", "HEAD", "OPTIONS"],
      cachedMethods: ["GET", "HEAD"],
      cachePolicyId: MANAGED_CACHING_OPTIMIZED_POLICY_ID,
      functionAssociations,
    },
    orderedCacheBehaviors: assetRoutes.map((route) => ({
      pathPattern: normalizeRoutePattern(route),
      targetOriginId: "site",
      viewerProtocolPolicy: "redirect-to-https",
      compress: true,
      allowedMethods: ["GET", "HEAD", "OPTIONS"],
      cachedMethods: ["GET", "HEAD"],
      cachePolicyId: MANAGED_CACHING_OPTIMIZED_POLICY_ID,
      functionAssociations,
    })),
    customErrorResponses: errorPage
      ? [
          {
            ErrorCode: 403,
            ResponseCode: props.spa ? "200" : "404",
            ResponsePagePath: `/${errorPage.replace(/^\/+/, "")}`,
            ErrorCachingMinTTL: 0,
          },
          {
            ErrorCode: 404,
            ResponseCode: props.spa ? "200" : "404",
            ResponsePagePath: `/${errorPage.replace(/^\/+/, "")}`,
            ErrorCachingMinTTL: 0,
          },
        ]
      : undefined,
    viewerCertificate: certificate
      ? {
          acmCertificateArn: (certificate as any).certificateArn,
          sslSupportMethod: "sni-only",
          minimumProtocolVersion: "TLSv1.2_2021",
        }
      : undefined,
    tags: props.tags,
  });

  yield* bucket.bind`Allow(cloudfront.amazonaws.com, AWS.S3.GetObject(${bucket}), {
  Source: ${distribution},
})`({
    policyStatements: [
      {
        Effect: "Allow",
        Principal: {
          Service: "cloudfront.amazonaws.com",
        },
        Action: ["s3:GetObject"],
        Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
        Condition: {
          StringEquals: {
            "AWS:SourceArn": distribution.distributionArn as any,
          },
        },
      },
    ],
  });

  const records =
    domain?.hostedZoneId && domain.dns !== false
      ? yield* Effect.forEach(
          [domain.name, ...(domain.aliases ?? []), ...(domain.redirects ?? [])],
          (name, index) =>
            Route53Record(`AliasRecord${index + 1}`, {
              hostedZoneId: domain.hostedZoneId!,
              name,
              type: "A",
              aliasTarget: {
                hostedZoneId: distribution.hostedZoneId,
                dnsName: distribution.domainName,
              },
            }),
          { concurrency: "unbounded" },
        )
      : [];

  const invalidation =
    invalidationProps === false
      ? undefined
      : yield* Invalidation("Invalidation", {
          distributionId: distribution.distributionId,
          version: files.version,
          wait: invalidationProps?.wait,
          paths: toInvalidationPaths(indexPage, invalidationProps?.paths),
        });

  return {
    bucket: bucket as any,
    build,
    files,
    originAccessControl: oac,
    certificate,
    distribution,
    records,
    invalidation,
    routeTarget,
    url: domain
      ? Output.interpolate`https://${domain.name}`
      : Output.interpolate`https://${distribution.domainName}`,
  };
});

const normalizePrefix = (prefix: string | undefined) =>
  prefix ? prefix.replace(/^\/+|\/+$/g, "") : "";

const normalizeRoutePath = (value: string) => {
  const normalized = `/${value.replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? normalized : normalized;
};

const normalizeRoutePattern = (value: string) => {
  const normalized = normalizeRoutePath(value);
  return normalized === "/" ? "/*" : `${normalized}/*`;
};

const toInvalidationPaths = (
  indexPage: string,
  paths?: "all" | "versioned" | string[],
) => {
  if (paths === "versioned") {
    return [`/${indexPage.replace(/^\/+/, "")}`];
  }
  if (!paths || paths === "all") {
    return ["/*"];
  }
  return paths;
};

const normalizeDomain = (
  domain: StaticSiteProps["domain"],
): WebsiteDomainProps | undefined =>
  typeof domain === "string" ? { name: domain } : domain;
