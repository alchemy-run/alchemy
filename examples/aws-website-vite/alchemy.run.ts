import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const aws = AWS.providers();

const WEBSITE_DOMAIN = Config.string("WEBSITE_DOMAIN").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

const WEBSITE_ZONE_ID = Config.string("WEBSITE_ZONE_ID").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
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
);

export default Alchemy.Stack(
  "AwsViteExample",
  { providers: aws, state: Alchemy.localState() },
  Effect.gen(function* () {
    /**
     * Optional Route 53 / ACM config.
     *
     * Set these before deploying if you want a custom domain:
     * - WEBSITE_DOMAIN=app.example.com
     * - WEBSITE_ZONE_ID=Z1234567890
     * - WEBSITE_ALIASES=www.app.example.com
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

    // A standalone site: it owns its own CloudFront distribution. To serve
    // several sites from one front door, see `examples/aws-router`.
    //
    // `alchemy deploy` runs `vite build` and serves the output from S3;
    // `alchemy dev` runs Vite's own dev server (HMR included) and the site's
    // url is the local server — no cloud resources are created.
    const site = yield* AWS.Website.Vite("FrontendSite", {
      domain: websiteDomain,
      invalidation: {
        paths: "all",
      },
      tags: {
        Example: "aws-website-vite",
        Surface: "website",
      },
    });

    return {
      url: site.url,
      cloudFrontDomain: site.distribution?.domainName,
      distributionId: site.distribution?.distributionId,
      bucketName: site.bucket?.bucketName,
      buildHash: site.build?.hash,
      assetVersion: site.files?.version,
      certificateArn: site.certificate?.certificateArn as any,
      customDomain: websiteDomain?.name,
    };
  }),
);
