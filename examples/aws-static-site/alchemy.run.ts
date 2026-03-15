import * as AWS from "alchemy-effect/AWS";
import * as Output from "alchemy-effect/Output";
import * as Stack from "alchemy-effect/Stack";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const aws = AWS.providers() as any;

const WEBSITE_DOMAIN = Config.string("WEBSITE_DOMAIN").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
  (config) => config.asEffect(),
);

const WEBSITE_ZONE_ID = Config.string("WEBSITE_ZONE_ID").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
  (config) => config.asEffect(),
);

const WEBSITE_ALIASES = Config.string("WEBSITE_ALIASES").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
  Config.map((value) =>
    value
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  ),
  (config) => config.asEffect(),
);

const stack = Effect.gen(function* () {
  /**
   * Optional Route 53 / ACM config.
   *
   * Set these before deploying if you want a custom domain:
   * - WEBSITE_DOMAIN=www.example.com
   * - WEBSITE_ZONE_ID=Z1234567890
   * - WEBSITE_ALIASES=example.com,static.example.com
   */
  const websiteDomainName = yield* WEBSITE_DOMAIN;
  const websiteZoneId = yield* WEBSITE_ZONE_ID;
  const websiteAliases = yield* WEBSITE_ALIASES;
  const websiteDomain =
    websiteDomainName && websiteZoneId
      ? {
          name: websiteDomainName,
          hostedZoneId: websiteZoneId,
          aliases: websiteAliases,
        }
      : undefined;

  const site = yield* AWS.Website.StaticSite("MarketingSite", {
    path: "./site",
    spa: true,
    domain: websiteDomain,
    forceDestroy: true,
    invalidation: {
      paths: "all",
    },
    tags: {
      Example: "aws-static-site",
      Surface: "website",
    },
  });

  return {
    url: site.url,
    cloudFrontDomain: site.distribution?.domainName,
    distributionId: site.distribution?.distributionId,
    bucketName: site.bucket.bucketName,
    assetVersion: site.files.version,
    certificateArn: site.certificate?.certificateArn as any,
    customDomain: websiteDomain?.name,
    aliasRecordNames: site.records.map((record) => record.name),
    invalidationId: site.invalidation?.invalidationId,
    dnsInstructions: websiteDomain
      ? Output.interpolate`Route 53 alias records are managed for ${websiteDomain.name}`
      : "Set WEBSITE_DOMAIN and WEBSITE_ZONE_ID to provision ACM + Route 53 records.",
  };
}).pipe(Stack.make("AwsStaticSiteExample", aws) as any);

export default stack;
