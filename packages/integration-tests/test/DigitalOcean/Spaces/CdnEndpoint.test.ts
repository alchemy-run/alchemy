import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getCdnEndpoint } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:spaces", "live"];
const LIVE_TIMEOUT = 240_000;

test.provider(
  "cdn endpoint: serve a bucket, change the ttl in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declare = (ttl: 3600 | 86400) =>
        Effect.gen(function* () {
          const bucket = yield* DigitalOcean.Spaces.Bucket("Site", {
            region: "nyc3",
            acl: "public-read",
          });
          const cdn = yield* DigitalOcean.Spaces.CdnEndpoint("Cdn", {
            origin: bucket.domainName,
            ttl,
          });
          return { bucket, cdn };
        });

      const created = yield* stack.deploy(declare(3600));
      expect(created.cdn.origin).toEqual(created.bucket.domainName);
      expect(created.cdn.endpoint).toEqual(
        `${created.bucket.bucketName}.nyc3.cdn.digitaloceanspaces.com`,
      );
      expect(created.cdn.ttl).toEqual(3600);

      const updated = yield* stack.deploy(declare(86400));
      expect(updated.cdn.cdnEndpointId).toEqual(created.cdn.cdnEndpointId);
      const remote = yield* getCdnEndpoint({ cdn_id: created.cdn.cdnEndpointId });
      expect(remote.endpoint.ttl).toEqual(86400);

      yield* stack.destroy();

      expect(yield* isGone(getCdnEndpoint({ cdn_id: created.cdn.cdnEndpointId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
