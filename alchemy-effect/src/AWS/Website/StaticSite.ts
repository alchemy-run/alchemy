import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { Certificate } from "../ACM/Certificate.ts";
import { Distribution } from "../CloudFront/Distribution.ts";
import { Invalidation } from "../CloudFront/Invalidation.ts";
import { OriginAccessControl } from "../CloudFront/OriginAccessControl.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { Record as Route53Record } from "../Route53/Record.ts";
import { Bucket } from "../S3/Bucket.ts";
import type { AssetFileOption } from "./AssetDeployment.ts";
import { AssetDeployment } from "./AssetDeployment.ts";
import type { StaticSiteRouteTarget, WebsiteDomainProps } from "./shared.ts";

export interface StaticSiteProps {
  /**
   * Local build output directory to upload.
   */
  sourcePath: Input<string>;
  /**
   * Optional deterministic S3 bucket name.
   */
  bucketName?: string;
  /**
   * Whether to delete uploaded objects before destroying the bucket.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Optional custom domain managed through Route 53.
   */
  domain?: WebsiteDomainProps;
  /**
   * Whether to configure SPA-style 403/404 rewrites to `index.html`.
   * @default false
   */
  spa?: boolean;
  /**
   * Root object served at `/`.
   * @default "index.html"
   */
  defaultRootObject?: string;
  /**
   * Optional key prefix for uploaded files.
   */
  prefix?: string;
  /**
   * Remove stale files under the prefix.
   * @default false
   */
  purge?: boolean;
  /**
   * Optional file overrides.
   */
  fileOptions?: AssetFileOption[];
  /**
   * Create a CloudFront invalidation after deployment.
   * @default true
   */
  invalidate?: boolean;
  /**
   * Whether to create a standalone CloudFront distribution for the site.
   * Set this to `false` when the site should be routed through `AWS.Website.Router`.
   * @default true
   */
  cdn?: boolean;
  /**
   * User-defined tags applied to created resources.
   */
  tags?: Record<string, string>;
}
/**
 * Compose a private S3-backed static site behind CloudFront.
 */
export const StaticSite = Effect.fn(function* (
  id: string,
  props: StaticSiteProps,
) {
  const defaultRootObject = props.defaultRootObject ?? "index.html";

  const bucket = yield* Bucket(`${id}Bucket`, {
    bucketName: props.bucketName,
    forceDestroy: props.forceDestroy,
    tags: props.tags,
  });

  const files = yield* AssetDeployment(`${id}Files`, {
    bucket,
    sourcePath: props.sourcePath,
    prefix: props.prefix,
    purge: props.purge ?? false,
    fileOptions: props.fileOptions,
  });

  const oac = yield* OriginAccessControl(`${id}OriginAccessControl`, {
    originType: "s3",
    description: `${id} static site origin access control`,
  });

  const routeTarget: StaticSiteRouteTarget = {
    bucket,
    originAccessControlId: oac.originAccessControlId,
    defaultRootObject,
    spa: props.spa,
    version: files.version,
  };

  if (props.cdn === false) {
    return {
      bucket,
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

  const certificate = props.domain
    ? yield* Certificate(`${id}Certificate`, {
        domainName: props.domain.name,
        subjectAlternativeNames: props.domain.aliases,
        hostedZoneId: props.domain.hostedZoneId,
        tags: props.tags,
      })
    : undefined;

  const distribution = yield* Distribution(`${id}Distribution`, {
    aliases: props.domain
      ? [props.domain.name, ...(props.domain.aliases ?? [])]
      : undefined,
    defaultRootObject,
    origins: [
      {
        id: "site",
        domainName: bucket.bucketRegionalDomainName,
        s3Origin: true,
        originAccessControlId: oac.originAccessControlId,
      },
    ],
    defaultCacheBehavior: {
      targetOriginId: "site",
      viewerProtocolPolicy: "redirect-to-https",
      compress: true,
      allowedMethods: ["GET", "HEAD"],
      cachedMethods: ["GET", "HEAD"],
      forwardedValues: {
        QueryString: false,
        Cookies: {
          Forward: "none",
        },
      },
      minTtl: 0,
      defaultTtl: 86400,
      maxTtl: 31536000,
    },
    customErrorResponses: props.spa
      ? [
          {
            ErrorCode: 403,
            ResponseCode: "200",
            ResponsePagePath: `/${defaultRootObject}`,
            ErrorCachingMinTTL: 0,
          },
          {
            ErrorCode: 404,
            ResponseCode: "200",
            ResponsePagePath: `/${defaultRootObject}`,
            ErrorCachingMinTTL: 0,
          },
        ]
      : undefined,
    viewerCertificate: certificate
      ? {
          acmCertificateArn: certificate.certificateArn,
          sslSupportMethod: "sni-only",
          minimumProtocolVersion: "TLSv1.2_2021",
        }
      : undefined,
    tags: props.tags,
  });

  const bucketPolicy: PolicyStatement = {
    Effect: "Allow",
    Principal: {
      Service: "cloudfront.amazonaws.com",
    },
    Action: ["s3:GetObject"],
    Resource: [Output.interpolate`${bucket.bucketArn}/*` as any],
  };

  yield* bucket.bind`AWS.S3.Policy(${distribution}, ${bucket})`({
    policyStatements: [bucketPolicy],
  });

  const records = props.domain
    ? yield* Effect.forEach(
        [props.domain.name, ...(props.domain.aliases ?? [])],
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

  const invalidation =
    props.invalidate === false
      ? undefined
      : yield* Invalidation(`${id}Invalidation`, {
          distributionId: distribution.distributionId,
          version: files.version,
        });

  return {
    bucket,
    files,
    originAccessControl: oac,
    certificate,
    distribution,
    records,
    invalidation,
    routeTarget,
    url: props.domain
      ? Output.interpolate`https://${props.domain.name}`
      : Output.interpolate`https://${distribution.domainName}`,
  };
});
