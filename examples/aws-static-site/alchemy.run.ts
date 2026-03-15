import * as AWS from "alchemy-effect/AWS";
import * as Stack from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";

const aws = AWS.providers();

const stack = Effect.gen(function* () {
  const site = yield* AWS.Website.StaticSite("MarketingSite", {
    path: "./site",
    // domain: "your.domain.com",
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
  };
}).pipe(Stack.make("AwsStaticSiteExample", aws));

export default stack;
