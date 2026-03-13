import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Output from "../../Output.ts";
import { Certificate } from "../ACM/Certificate.ts";
import { Distribution, type DistributionBehavior, type DistributionOrigin } from "../CloudFront/Distribution.ts";
import { Function as CloudFrontFunction } from "../CloudFront/Function.ts";
import { Invalidation } from "../CloudFront/Invalidation.ts";
import {
  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
  MANAGED_CACHING_DISABLED_POLICY_ID,
  MANAGED_CACHING_OPTIMIZED_POLICY_ID,
} from "../CloudFront/ManagedPolicies.ts";
import { OriginAccessControl } from "../CloudFront/OriginAccessControl.ts";
import { Record as Route53Record } from "../Route53/Record.ts";
import type {
  RouterBucketRouteProps,
  RouterProps,
  RouterRoute,
  RouterUrlRouteProps,
} from "./shared.ts";

const isUrlRoute = (route: RouterRoute): route is RouterUrlRouteProps =>
  typeof route === "string" || "url" in (route as any);

const normalizeRoute = (route: RouterRoute): RouterUrlRouteProps | RouterBucketRouteProps =>
  typeof route === "string" ? { url: route } : route;

const normalizePattern = (pattern: string) => {
  if (!pattern.startsWith("/")) {
    throw new Error(
      `Router currently supports path-based routes only. Received '${pattern}'.`,
    );
  }
  if (pattern === "/" || pattern === "/*") {
    return "/*";
  }
  if (pattern.includes("*")) {
    return pattern;
  }
  return pattern.endsWith("/") ? `${pattern}*` : `${pattern}*`;
};

const bucketDomainNameOf = (bucket: RouterBucketRouteProps["bucket"]) =>
  typeof bucket === "string"
    ? bucket
    : (((bucket as any).bucketRegionalDomainName ?? bucket) as string);

const toAllowedMethods = (route: RouterUrlRouteProps | RouterBucketRouteProps) =>
  isUrlRoute(route)
    ? (route.allowedMethods ?? [
        "DELETE",
        "GET",
        "HEAD",
        "OPTIONS",
        "PATCH",
        "POST",
        "PUT",
      ])
    : ["GET", "HEAD", "OPTIONS"];

const toCachedMethods = (route: RouterUrlRouteProps | RouterBucketRouteProps) =>
  isUrlRoute(route) ? (route.cachedMethods ?? ["GET", "HEAD"]) : ["GET", "HEAD"];

const buildViewerRequestCode = (
  route: RouterUrlRouteProps | RouterBucketRouteProps,
) => {
  const userInjection = route.edge?.viewerRequest?.injection ?? "";
  const rewrite = route.rewrite
    ? `
  const rewriteRegex = new RegExp(${JSON.stringify(route.rewrite.regex)});
  request.uri = request.uri.replace(rewriteRegex, ${JSON.stringify(route.rewrite.to)});
`
    : "";

  return `async function handler(event) {
  const request = event.request;
  const host = request.headers.host?.value ?? "";
  request.headers["x-forwarded-host"] = { value: host };
${rewrite}${userInjection ? `\n${userInjection}\n` : ""}
  return request;
}
`;
};

const buildViewerResponseCode = (
  route: RouterUrlRouteProps | RouterBucketRouteProps,
) => {
  const userInjection = route.edge?.viewerResponse?.injection ?? "";
  return `async function handler(event) {
  const response = event.response;
${userInjection ? `\n${userInjection}\n` : ""}
  return response;
}
`;
};

const toInvalidationPaths = (
  routes: Record<string, RouterRoute>,
  paths?: "all" | "versioned" | string[],
) => {
  if (paths === "versioned") {
    return Object.entries(routes)
      .filter(([, route]) => !isUrlRoute(normalizeRoute(route)))
      .map(([pattern]) => normalizePattern(pattern));
  }
  if (paths === "all" || !paths) {
    return ["/*"];
  }
  return paths;
};

/**
 * Shared CloudFront front door for multiple website routes.
 *
 * `Router` owns a single CloudFront distribution and maps path patterns to
 * either HTTP origins or S3 bucket origins.
 *
 * @section Creating Routers
 * @example URL And Bucket Routes
 * ```typescript
 * const router = yield* Router("WebsiteRouter", {
 *   routes: {
 *     "/*": { bucket: docs.bucket.bucketRegionalDomainName },
 *     "/api*": { url: api.function.functionUrl as any },
 *   },
 * });
 * ```
 */
export const Router = Effect.fn(function* (id: string, props: RouterProps) {
  const normalizedEntries = Object.entries(props.routes).map(([pattern, route]) => [
    normalizePattern(pattern),
    normalizeRoute(route),
  ] as const);

  const needsBucketOac = normalizedEntries.some(
    ([, route]) => !isUrlRoute(route) && !route.originAccessControlId,
  );

  const sharedBucketOac = needsBucketOac
    ? yield* OriginAccessControl(`${id}OriginAccessControl`, {
        originType: "s3",
        description: `${id} router origin access control`,
      })
    : undefined;

  const certificate = props.domain
    ? yield* Certificate(`${id}Certificate`, {
        domainName: props.domain.name,
        subjectAlternativeNames: [
          ...(props.domain.aliases ?? []),
          ...(props.domain.redirects ?? []),
        ],
        hostedZoneId: props.domain.hostedZoneId,
        tags: props.tags,
      })
    : undefined;

  const routeSpecs = yield* Effect.forEach(
    normalizedEntries,
    ([pattern, route], index) =>
      Effect.gen(function* () {
        const routeId = `route${index + 1}`;
        const viewerRequestFn =
          route.edge?.viewerRequest || route.rewrite
            ? yield* CloudFrontFunction(`${id}${routeId}ViewerRequest`, {
                comment: `${id} ${pattern} viewer request`,
                code: buildViewerRequestCode(route),
                keyValueStoreArns: route.edge?.viewerRequest?.keyValueStoreArn
                  ? [route.edge.viewerRequest.keyValueStoreArn as any]
                  : undefined,
              })
            : undefined;

        const viewerResponseFn = route.edge?.viewerResponse
          ? yield* CloudFrontFunction(`${id}${routeId}ViewerResponse`, {
              comment: `${id} ${pattern} viewer response`,
              code: buildViewerResponseCode(route),
              keyValueStoreArns: route.edge?.viewerResponse?.keyValueStoreArn
                ? [route.edge.viewerResponse.keyValueStoreArn as any]
                : undefined,
            })
          : undefined;

        const origin: DistributionOrigin = isUrlRoute(route)
          ? {
              id: routeId,
              domainName: Output.map((url: string) => new URL(url).host)(
                route.url as any,
              ) as any,
              customOriginConfig: {
                httpPort: 80,
                httpsPort: 443,
                originProtocolPolicy: route.originProtocolPolicy ?? "https-only",
                originReadTimeout: route.originReadTimeout ?? 20,
                originKeepaliveTimeout: route.originKeepaliveTimeout,
                originSslProtocols: route.originSslProtocols ?? ["TLSv1.2"],
              },
            }
          : {
              id: routeId,
              domainName: bucketDomainNameOf(route.bucket),
              originPath: route.originPath,
              s3Origin: true,
              originAccessControlId:
                route.originAccessControlId ??
                sharedBucketOac?.originAccessControlId,
            };

        const behavior: DistributionBehavior & { pathPattern: string } = {
          pathPattern: pattern,
          targetOriginId: routeId,
          viewerProtocolPolicy: "redirect-to-https",
          allowedMethods: toAllowedMethods(route),
          cachedMethods: toCachedMethods(route),
          compress: true,
          cachePolicyId: isUrlRoute(route)
            ? (route.cachePolicyId as any) ?? MANAGED_CACHING_DISABLED_POLICY_ID
            : (route.cachePolicyId as any) ?? MANAGED_CACHING_OPTIMIZED_POLICY_ID,
          originRequestPolicyId: isUrlRoute(route)
            ? MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID
            : undefined,
          functionAssociations: [
            ...(viewerRequestFn
              ? [
                  {
                    eventType: "viewer-request" as const,
                    functionArn: viewerRequestFn.functionArn as any,
                  },
                ]
              : []),
            ...(viewerResponseFn
              ? [
                  {
                    eventType: "viewer-response" as const,
                    functionArn: viewerResponseFn.functionArn as any,
                  },
                ]
              : []),
          ],
        };

        return { pattern, route, origin, behavior };
      }),
    { concurrency: "unbounded" },
  );

  const defaultRoute =
    routeSpecs.find((spec) => spec.pattern === "/*") ?? routeSpecs[0];

  if (!defaultRoute) {
    return yield* Effect.fail(new Error("Router requires at least one route"));
  }

  const customErrorResponses =
    !isUrlRoute(defaultRoute.route) &&
    defaultRoute.route.spa &&
    defaultRoute.pattern === "/*"
      ? [
          {
            ErrorCode: 403,
            ResponseCode: "200",
            ResponsePagePath: `/${defaultRoute.route.defaultRootObject ?? "index.html"}`,
            ErrorCachingMinTTL: 0,
          },
          {
            ErrorCode: 404,
            ResponseCode: "200",
            ResponsePagePath: `/${defaultRoute.route.defaultRootObject ?? "index.html"}`,
            ErrorCachingMinTTL: 0,
          },
        ]
      : undefined;

  const { pathPattern: _defaultPathPattern, ...defaultBehavior } =
    defaultRoute.behavior;

  const distribution = yield* Distribution(`${id}Distribution`, {
    aliases: props.domain
      ? [
          props.domain.name,
          ...(props.domain.aliases ?? []),
          ...(props.domain.redirects ?? []),
        ]
      : undefined,
    defaultRootObject:
      !isUrlRoute(defaultRoute.route)
        ? defaultRoute.route.defaultRootObject
        : undefined,
    origins: routeSpecs.map((spec) => spec.origin),
    defaultCacheBehavior: defaultBehavior,
    orderedCacheBehaviors: routeSpecs
      .filter((spec) => spec !== defaultRoute)
      .map((spec) => spec.behavior),
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

  const records = props.domain
    ? yield* Effect.forEach(
        [
          props.domain.name,
          ...(props.domain.aliases ?? []),
          ...(props.domain.redirects ?? []),
        ],
        (name, index) =>
          Route53Record(`${id}AliasRecord${index + 1}`, {
            hostedZoneId: props.domain!.hostedZoneId,
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

  const routeVersions = Output.all(
    ...(routeSpecs.map((spec) =>
      Output.interpolate`${spec.route.version ?? `${spec.pattern}:${isUrlRoute(spec.route) ? "url" : "bucket"}`}`,
    ) as any),
  ) as any;

  const invalidationVersion = Output.map((values: unknown[]) =>
    createHash("sha256").update(JSON.stringify(values)).digest("hex"),
  )(routeVersions);

  const invalidation =
    props.invalidation === false || !props.invalidation
      ? undefined
      : yield* Invalidation(`${id}Invalidation`, {
          distributionId: distribution.distributionId,
          version: invalidationVersion as any,
          wait: props.invalidation.wait,
          paths: toInvalidationPaths(props.routes, props.invalidation.paths),
        });

  return {
    certificate,
    distribution,
    records,
    invalidation,
    url: props.domain
      ? Output.interpolate`https://${props.domain.name}`
      : Output.interpolate`https://${distribution.domainName}`,
    routes: routeSpecs,
  };
});
