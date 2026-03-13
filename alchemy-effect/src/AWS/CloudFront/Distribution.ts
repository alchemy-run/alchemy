import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Input } from "../../Input.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";

const CLOUDFRONT_HOSTED_ZONE_ID = "Z2FDTNDATAQYW2" as const;

export interface DistributionOrigin {
  /**
   * Unique origin identifier inside the distribution.
   */
  id: string;
  /**
   * Origin domain name.
   */
  domainName: Input<string>;
  /**
   * Optional origin path prefix.
   */
  originPath?: Input<string>;
  /**
   * CloudFront Origin Access Control identifier.
   */
  originAccessControlId?: Input<string>;
  /**
   * Whether the origin should be modeled as an S3 origin.
   * @default false
   */
  s3Origin?: boolean;
  /**
   * Optional custom origin settings.
   */
  customOriginConfig?: {
    httpPort?: number;
    httpsPort?: number;
    originProtocolPolicy?: cloudfront.OriginProtocolPolicy;
    originReadTimeout?: number;
    originKeepaliveTimeout?: number;
    originSslProtocols?: cloudfront.SslProtocol[];
  };
}

export interface DistributionBehavior {
  targetOriginId: string;
  viewerProtocolPolicy?: cloudfront.ViewerProtocolPolicy;
  allowedMethods?: cloudfront.Method[];
  cachedMethods?: cloudfront.Method[];
  compress?: boolean;
  cachePolicyId?: string;
  originRequestPolicyId?: string;
  responseHeadersPolicyId?: string;
  forwardedValues?: cloudfront.ForwardedValues;
  minTtl?: number;
  defaultTtl?: number;
  maxTtl?: number;
  functionAssociations?: {
    functionArn: string;
    eventType: cloudfront.EventType;
  }[];
  lambdaFunctionAssociations?: {
    lambdaFunctionArn: string;
    eventType: cloudfront.EventType;
    includeBody?: boolean;
  }[];
}

export interface DistributionViewerCertificate {
  cloudFrontDefaultCertificate?: boolean;
  acmCertificateArn?: string;
  sslSupportMethod?: cloudfront.SSLSupportMethod;
  minimumProtocolVersion?: cloudfront.MinimumProtocolVersion;
}

export interface DistributionProps {
  /**
   * Alternate domain names routed to this distribution.
   */
  aliases?: string[];
  /**
   * Default root object served for `/`.
   */
  defaultRootObject?: string;
  /**
   * CloudFront origin definitions.
   */
  origins: Input<DistributionOrigin[]>;
  /**
   * Default cache behavior.
   */
  defaultCacheBehavior: Input<DistributionBehavior>;
  /**
   * Ordered cache behaviors.
   */
  orderedCacheBehaviors?: Input<
    Array<
      DistributionBehavior & {
        pathPattern: string;
      }
    >
  >;
  /**
   * Custom error response rules.
   */
  customErrorResponses?: Input<cloudfront.CustomErrorResponse[]>;
  /**
   * Human-readable distribution comment.
   * @default ""
   */
  comment?: string;
  /**
   * Whether the distribution should serve traffic.
   * @default true
   */
  enabled?: boolean;
  /**
   * Viewer certificate configuration.
   */
  viewerCertificate?: Input<DistributionViewerCertificate>;
  /**
   * CloudFront price class.
   */
  priceClass?: cloudfront.PriceClass;
  /**
   * Optional AWS WAF web ACL association.
   */
  webAclId?: string;
  /**
   * Preferred HTTP version support.
   */
  httpVersion?: cloudfront.HttpVersion;
  /**
   * Whether IPv6 should be enabled.
   * @default true
   */
  isIpv6Enabled?: boolean;
  /**
   * User-defined tags to apply to the distribution.
   */
  tags?: Record<string, string>;
}

export interface Distribution extends Resource<
  "AWS.CloudFront.Distribution",
  DistributionProps,
  {
    /**
     * CloudFront distribution identifier.
     */
    distributionId: string;
    /**
     * ARN of the distribution.
     */
    distributionArn: string;
    /**
     * CloudFront-assigned domain name.
     */
    domainName: string;
    /**
     * Route 53 hosted zone ID for CloudFront aliases.
     */
    hostedZoneId: string;
    /**
     * Current deployment status.
     */
    status: string;
    /**
     * Configured alternate domain names.
     */
    aliases: string[];
    /**
     * Current comment.
     */
    comment: string;
    /**
     * Whether the distribution is enabled.
     */
    enabled: boolean;
    /**
     * Most recent entity tag for update/delete operations.
     */
    etag: string | undefined;
    /**
     * Number of invalidation batches still in progress.
     */
    inProgressInvalidationBatches: number;
    /**
     * Last CloudFront modification timestamp.
     */
    lastModifiedTime: Date | undefined;
    /**
     * Current tags on the distribution.
     */
    tags: Record<string, string>;
  }
> {}

/**
 * A CloudFront distribution.
 *
 * `Distribution` manages the CDN layer for static sites and HTTP origins such
 * as Lambda Function URLs and ALBs. It exposes the distribution domain and
 * hosted zone ID needed for Route 53 alias records.
 *
 * @section Creating Distributions
 * @example Private S3 Origin
 * ```typescript
 * const distribution = yield* Distribution("WebsiteCdn", {
 *   aliases: ["www.example.com"],
 *   origins: [
 *     {
 *       id: "site",
 *       domainName: bucket.bucketRegionalDomainName,
 *       s3Origin: true,
 *       originAccessControlId: oac.originAccessControlId,
 *     },
 *   ],
 *   defaultCacheBehavior: {
 *     targetOriginId: "site",
 *     viewerProtocolPolicy: "redirect-to-https",
 *     compress: true,
 *   },
 *   viewerCertificate: {
 *     acmCertificateArn: certificate.certificateArn,
 *     sslSupportMethod: "sni-only",
 *     minimumProtocolVersion: "TLSv1.2_2021",
 *   },
 * });
 * ```
 */
export const Distribution = Resource<Distribution>("AWS.CloudFront.Distribution");

const toTagsRecord = (tags: cloudfront.Tag[] | undefined) =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const isAccessDenied = (error: unknown) => {
  const tag = (error as { _tag?: string; name?: string })?._tag;
  const name = (error as { _tag?: string; name?: string })?.name;
  const text = String(error);
  return (
    tag === "AccessDenied" ||
    tag === "AccessDeniedException" ||
    name === "AccessDenied" ||
    name === "AccessDeniedException" ||
    text.includes("AccessDenied")
  );
};

const toBehavior = (
  behavior: DistributionBehavior & {
    pathPattern?: string;
  },
): cloudfront.CacheBehavior | cloudfront.DefaultCacheBehavior => ({
  ...(behavior.pathPattern ? { PathPattern: behavior.pathPattern } : undefined),
  TargetOriginId: behavior.targetOriginId,
  ViewerProtocolPolicy: behavior.viewerProtocolPolicy ?? "redirect-to-https",
  AllowedMethods: behavior.allowedMethods
    ? {
        Quantity: behavior.allowedMethods.length,
        Items: behavior.allowedMethods,
        CachedMethods: behavior.cachedMethods
          ? {
              Quantity: behavior.cachedMethods.length,
              Items: behavior.cachedMethods,
            }
          : undefined,
      }
    : undefined,
  Compress: behavior.compress ?? true,
  CachePolicyId: behavior.cachePolicyId,
  OriginRequestPolicyId: behavior.originRequestPolicyId,
  ResponseHeadersPolicyId: behavior.responseHeadersPolicyId,
  ForwardedValues: behavior.forwardedValues,
  MinTTL: behavior.minTtl,
  DefaultTTL: behavior.defaultTtl,
  MaxTTL: behavior.maxTtl,
  FunctionAssociations: behavior.functionAssociations
    ? {
        Quantity: behavior.functionAssociations.length,
        Items: behavior.functionAssociations.map((association) => ({
          FunctionARN: association.functionArn,
          EventType: association.eventType,
        })),
      }
    : undefined,
  LambdaFunctionAssociations: behavior.lambdaFunctionAssociations
    ? {
        Quantity: behavior.lambdaFunctionAssociations.length,
        Items: behavior.lambdaFunctionAssociations.map((association) => ({
          LambdaFunctionARN: association.lambdaFunctionArn,
          EventType: association.eventType,
          IncludeBody: association.includeBody,
        })),
      }
    : undefined,
});

const toOrigin = (origin: DistributionOrigin): cloudfront.Origin => ({
  Id: origin.id,
  DomainName: origin.domainName as string,
  OriginPath: origin.originPath as string | undefined,
  OriginAccessControlId: origin.originAccessControlId as string | undefined,
  S3OriginConfig: origin.s3Origin ? { OriginAccessIdentity: "" } : undefined,
  CustomOriginConfig: origin.s3Origin
    ? undefined
    : {
        HTTPPort: origin.customOriginConfig?.httpPort ?? 80,
        HTTPSPort: origin.customOriginConfig?.httpsPort ?? 443,
        OriginProtocolPolicy:
          origin.customOriginConfig?.originProtocolPolicy ?? "https-only",
        OriginSslProtocols: {
          Quantity: (origin.customOriginConfig?.originSslProtocols ?? ["TLSv1.2"])
            .length,
          Items: origin.customOriginConfig?.originSslProtocols ?? ["TLSv1.2"],
        },
        OriginReadTimeout: origin.customOriginConfig?.originReadTimeout,
        OriginKeepaliveTimeout: origin.customOriginConfig?.originKeepaliveTimeout,
      },
});

const toConfig = (
  callerReference: string,
  props: DistributionProps,
): cloudfront.DistributionConfig => ({
  CallerReference: callerReference,
  Aliases: props.aliases
    ? {
        Quantity: props.aliases.length,
        Items: props.aliases,
      }
    : undefined,
  DefaultRootObject: props.defaultRootObject,
  Origins: {
    Quantity: (props.origins as DistributionOrigin[]).length,
    Items: (props.origins as DistributionOrigin[]).map(toOrigin),
  },
  DefaultCacheBehavior: toBehavior(
    props.defaultCacheBehavior as DistributionBehavior,
  ) as cloudfront.DefaultCacheBehavior,
  CacheBehaviors: props.orderedCacheBehaviors
    ? {
        Quantity: (props.orderedCacheBehaviors as Array<
          DistributionBehavior & { pathPattern: string }
        >).length,
        Items: (props.orderedCacheBehaviors as Array<
          DistributionBehavior & { pathPattern: string }
        >).map((behavior) =>
          toBehavior(behavior as DistributionBehavior & { pathPattern: string }),
        ) as cloudfront.CacheBehavior[],
      }
    : undefined,
  CustomErrorResponses: props.customErrorResponses
    ? {
        Quantity: (props.customErrorResponses as cloudfront.CustomErrorResponse[])
          .length,
        Items: props.customErrorResponses as cloudfront.CustomErrorResponse[],
      }
    : undefined,
  Comment: props.comment ?? "",
  Enabled: props.enabled ?? true,
  ViewerCertificate: props.viewerCertificate
    ? {
        CloudFrontDefaultCertificate:
          (props.viewerCertificate as DistributionViewerCertificate)
            .cloudFrontDefaultCertificate,
        ACMCertificateArn: (props.viewerCertificate as DistributionViewerCertificate)
          .acmCertificateArn,
        SSLSupportMethod: (props.viewerCertificate as DistributionViewerCertificate)
          .sslSupportMethod,
        MinimumProtocolVersion: (
          props.viewerCertificate as DistributionViewerCertificate
        ).minimumProtocolVersion,
      }
    : props.aliases && props.aliases.length > 0
      ? undefined
      : {
          CloudFrontDefaultCertificate: true,
        },
  Restrictions: {
    GeoRestriction: {
      RestrictionType: "none",
      Quantity: 0,
    },
  },
  PriceClass: props.priceClass,
  WebACLId: props.webAclId,
  HttpVersion: props.httpVersion ?? "http2",
  IsIPV6Enabled: props.isIpv6Enabled ?? true,
});

const toAttrs = (
  distribution: cloudfront.Distribution,
  etag: string | undefined,
  tags: Record<string, string>,
): Distribution["Attributes"] => ({
  distributionId: distribution.Id,
  distributionArn: distribution.ARN,
  domainName: distribution.DomainName,
  hostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
  status: distribution.Status,
  aliases: distribution.DistributionConfig.Aliases?.Items ?? [],
  comment:
    typeof distribution.DistributionConfig.Comment === "string"
      ? distribution.DistributionConfig.Comment
      : "",
  enabled: distribution.DistributionConfig.Enabled,
  etag,
  inProgressInvalidationBatches: distribution.InProgressInvalidationBatches,
  lastModifiedTime: distribution.LastModifiedTime,
  tags,
});

export const DistributionProvider = () =>
  Distribution.provider.effect(
    Effect.gen(function* () {
      const waitForDeployment = Effect.fn(function* (distributionId: string) {
        return yield* cloudfront.getDistribution({ Id: distributionId }).pipe(
          Effect.map((response) => response.Distribution),
          Effect.flatMap((distribution) =>
            distribution?.Status === "Deployed"
              ? Effect.succeed(distribution)
              : Effect.fail(new Error("DistributionPendingDeployment"))
          ),
          Effect.retry({
            while: (error) =>
              error instanceof Error &&
              error.message === "DistributionPendingDeployment",
            schedule: Schedule.fixed("10 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
          }),
        );
      });

      const getCurrent = Effect.fn(function* (distributionId: string) {
        const distribution = yield* cloudfront
          .getDistribution({ Id: distributionId })
          .pipe(
            Effect.map((response) => response.Distribution),
            Effect.catchTag("NoSuchDistribution", () => Effect.succeed(undefined)),
          );

        if (!distribution?.Id) {
          return undefined;
        }

        const config = yield* cloudfront.getDistributionConfig({
          Id: distributionId,
        });
        const tags = yield* cloudfront
          .listTagsForResource({
            Resource: distribution.ARN,
          })
          .pipe(Effect.map((response) => toTagsRecord(response.Tags.Items)));

        return {
          distribution,
          config: config.DistributionConfig!,
          etag: config.ETag,
          tags,
        };
      });

      return {
        stables: ["distributionId", "distributionArn", "domainName", "hostedZoneId"],
        read: Effect.fn(function* ({ output }) {
          if (!output?.distributionId) {
            return undefined;
          }

          const current = yield* getCurrent(output.distributionId);
          if (!current) {
            return undefined;
          }

          return toAttrs(current.distribution, current.etag, current.tags);
        }),
        create: Effect.fn(function* ({ id, instanceId, news, session }) {
          const tags = {
            ...(yield* createInternalTags(id)),
            ...(news.tags ?? {}),
          };

          const callerReference = instanceId;
          const config = toConfig(callerReference, news);
          const created = yield* cloudfront
            .createDistributionWithTags({
              DistributionConfigWithTags: {
                DistributionConfig: config,
                Tags: {
                  Items: createTagsList(tags),
                },
              },
            })
            .pipe(
              Effect.catch((error) =>
                isAccessDenied(error)
                  ? Effect.gen(function* () {
                      const created = yield* cloudfront.createDistribution({
                        DistributionConfig: config,
                      });

                      if (
                        created.Distribution?.ARN &&
                        Object.keys(tags).length > 0
                      ) {
                        yield* cloudfront.tagResource({
                          Resource: created.Distribution.ARN,
                          Tags: {
                            Items: createTagsList(tags),
                          },
                        });
                      }

                      return created;
                    })
                  : Effect.fail(error),
              ),
            );

          if (!created.Distribution?.Id) {
            return yield* Effect.fail(
              new Error("createDistribution returned no distribution"),
            );
          }

          const deployed = yield* waitForDeployment(created.Distribution.Id);
          yield* session.note(created.Distribution.Id);
          return toAttrs(deployed, created.ETag, tags);
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const current = yield* getCurrent(output.distributionId);
          if (!current) {
            return yield* Effect.fail(
              new Error(
                `CloudFront distribution '${output.distributionId}' was not found`,
              ),
            );
          }

          const updated = yield* cloudfront.updateDistribution({
            Id: output.distributionId,
            IfMatch: current.etag,
            DistributionConfig: toConfig(
              current.config.CallerReference,
              news,
            ),
          });

          const oldTags = {
            ...(yield* createInternalTags(id)),
            ...(olds.tags ?? {}),
          };
          const newTags = {
            ...(yield* createInternalTags(id)),
            ...(news.tags ?? {}),
          };
          const { removed, upsert } = diffTags(oldTags, newTags);

          if (upsert.length > 0) {
            yield* cloudfront.tagResource({
              Resource: output.distributionArn,
              Tags: {
                Items: upsert,
              },
            });
          }

          if (removed.length > 0) {
            yield* cloudfront.untagResource({
              Resource: output.distributionArn,
              TagKeys: {
                Items: removed,
              },
            });
          }

          if (!updated.Distribution?.Id) {
            return yield* Effect.fail(
              new Error("updateDistribution returned no distribution"),
            );
          }

          const deployed = yield* waitForDeployment(updated.Distribution.Id);
          yield* session.note(output.distributionId);
          return toAttrs(deployed, updated.ETag, newTags);
        }),
        delete: Effect.fn(function* ({ output }) {
          const current = yield* getCurrent(output.distributionId);
          if (!current) {
            return;
          }

          if (current.config.Enabled) {
            yield* cloudfront.updateDistribution({
              Id: output.distributionId,
              IfMatch: current.etag,
              DistributionConfig: {
                ...current.config,
                Enabled: false,
              },
            });
            yield* waitForDeployment(output.distributionId);
          }

          const latest = yield* getCurrent(output.distributionId);
          if (!latest) {
            return;
          }

          yield* cloudfront
            .deleteDistribution({
              Id: output.distributionId,
              IfMatch: latest.etag,
            })
            .pipe(
              Effect.catchTag("NoSuchDistribution", () => Effect.void),
            );
        }),
      };
    }),
  );
