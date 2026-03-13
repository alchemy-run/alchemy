import type * as cloudfront from "@distilled.cloud/aws/cloudfront";
import type { Input } from "../../Input.ts";
import type { Bucket } from "../S3/Bucket.ts";

export interface WebsiteDomainProps {
  /**
   * Primary domain name for the website or router.
   */
  name: string;
  /**
   * Hosted zone used for Route 53 automation.
   */
  hostedZoneId: string;
  /**
   * Additional aliases that should point at the same distribution.
   */
  aliases?: string[];
  /**
   * Optional aliases that should redirect to the primary domain.
   */
  redirects?: string[];
}

export interface WebsiteRewrite {
  /**
   * Regex matched against the request URI.
   */
  regex: string;
  /**
   * Replacement path forwarded to the origin.
   */
  to: string;
}

export interface WebsiteEdgeInjection {
  /**
   * JavaScript injected into the generated CloudFront Function body.
   */
  injection: string;
  /**
   * Optional associated KeyValueStore ARN for the function.
   */
  keyValueStoreArn?: Input<string>;
}

export interface WebsiteEdgeProps {
  /**
   * Additional logic for viewer request handling.
   */
  viewerRequest?: WebsiteEdgeInjection;
  /**
   * Additional logic for viewer response handling.
   */
  viewerResponse?: WebsiteEdgeInjection;
}

export interface WebsiteInvalidationProps {
  /**
   * Wait for the CloudFront invalidation to finish.
   * @default false
   */
  wait?: boolean;
  /**
   * Paths to invalidate.
   * @default "all"
   */
  paths?: "all" | "versioned" | string[];
}

export interface RouterCommonRouteProps {
  /**
   * Optional version token used to trigger invalidations when the route's
   * underlying content changes.
   */
  version?: Input<string>;
  /**
   * CloudFront cache policy ID used by the route.
   */
  cachePolicyId?: Input<string>;
  /**
   * Optional path rewrite performed before the request hits the origin.
   */
  rewrite?: WebsiteRewrite;
  /**
   * Optional edge customizations for the route.
   */
  edge?: WebsiteEdgeProps;
}

export interface RouterUrlRouteProps extends RouterCommonRouteProps {
  /**
   * Destination URL.
   */
  url: Input<string>;
  /**
   * Origin protocol policy between CloudFront and the origin.
   * @default "https-only"
   */
  originProtocolPolicy?: cloudfront.OriginProtocolPolicy;
  /**
   * Origin read timeout in seconds.
   */
  originReadTimeout?: number;
  /**
   * Origin keepalive timeout in seconds.
   */
  originKeepaliveTimeout?: number;
  /**
   * Supported origin TLS versions.
   */
  originSslProtocols?: cloudfront.SslProtocol[];
  /**
   * Allowed methods forwarded to the origin.
   */
  allowedMethods?: cloudfront.Method[];
  /**
   * Cached methods.
   */
  cachedMethods?: cloudfront.Method[];
}

export interface RouterBucketRouteProps extends RouterCommonRouteProps {
  /**
   * Bucket or bucket regional domain name served by the route.
   */
  bucket: Bucket | Input<string> | { bucketRegionalDomainName: Input<string> };
  /**
   * Optional CloudFront OAC to attach to the S3 origin.
   */
  originAccessControlId?: Input<string>;
  /**
   * Additional origin path prefix.
   */
  originPath?: Input<string>;
  /**
   * Root object served for directory requests.
   */
  defaultRootObject?: string;
  /**
   * Whether the route should use SPA-style error rewrites.
   * @default false
   */
  spa?: boolean;
}

export type RouterRoute = string | RouterUrlRouteProps | RouterBucketRouteProps;

export interface RouterProps {
  /**
   * Optional custom domain managed through Route 53.
   */
  domain?: WebsiteDomainProps;
  /**
   * Route map keyed by CloudFront path pattern.
   */
  routes: Record<string, RouterRoute>;
  /**
   * Optional edge behavior shared by the router's default behavior.
   */
  edge?: WebsiteEdgeProps;
  /**
   * Optional invalidation behavior for route updates.
   * @default false
   */
  invalidation?: false | WebsiteInvalidationProps;
  /**
   * User-defined tags applied to created resources.
   */
  tags?: Record<string, string>;
}

export type StaticSiteRouteTarget = RouterBucketRouteProps;

export interface SsrSiteRouteTargets {
  server: RouterUrlRouteProps;
  assets?: {
    pattern: string;
    route: RouterBucketRouteProps;
  };
}
