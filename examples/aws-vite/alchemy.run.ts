import * as AWS from "alchemy-effect/AWS";
import * as Build from "alchemy-effect/Build";
import * as Output from "alchemy-effect/Output";
import * as Stack from "alchemy-effect/Stack";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const aws = Layer.mergeAll(AWS.providers(), Build.BuildProvider()) as any;

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

  const build = yield* Build.Build("FrontendBuild", {
    command: "bun run build",
    cwd: ".",
    include: [
      "index.html",
      "package.json",
      "vite.config.ts",
      "src/**/*.ts",
      "src/**/*.css",
    ],
    output: "dist",
  });

  const site = yield* AWS.Website.StaticSite("FrontendSite", {
    sourcePath: build.path,
    spa: true,
    cdn: false,
    tags: {
      Example: "aws-vite",
      Surface: "website",
    },
  });

  const router = yield* AWS.Website.Router("FrontendRouter", {
    domain: websiteDomain,
    routes: {
      "/*": site.routeTarget,
    },
    invalidation: {
      paths: "all",
    },
    tags: {
      Example: "aws-vite",
      Surface: "website",
      Mode: "router",
    },
  });

  return {
    url: router.url,
    cloudFrontDomain: router.distribution.domainName,
    distributionId: router.distribution.distributionId,
    bucketName: site.bucket.bucketName,
    buildHash: build.hash,
    assetVersion: site.files.version,
    certificateArn: router.certificate?.certificateArn as any,
    customDomain: websiteDomain?.name,
    aliasRecordNames: router.records.map((record) => record.name),
    previewHint: Output.interpolate`Run bun run dev:vite for local frontend iteration, then deploy to publish ${router.distribution.domainName}`,
  };
}).pipe(Stack.make("AwsViteExample", aws) as any);

export default stack;
