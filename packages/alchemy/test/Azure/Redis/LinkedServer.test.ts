import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as redis from "@distilled.cloud/azure/redis";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLink = (
  resourceGroupName: string,
  name: string,
  linkedServerName: string,
) =>
  Effect.gen(function* () {
    return yield* redis.GetLinkedServer({
      subscriptionId: yield* subscription,
      resourceGroupName,
      name,
      linkedServerName,
    });
  });

const program = (props: { linked: "Secondary" | "Tertiary" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const primary = yield* Azure.Redis.Cache("Primary", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      sku: "Premium",
      capacity: 1,
    });
    // Both candidate secondaries stay deployed across the replacement step.
    const secondary = yield* Azure.Redis.Cache("Secondary", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "Premium",
      capacity: 1,
    });
    const tertiary = yield* Azure.Redis.Cache("Tertiary", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "Premium",
      capacity: 1,
    });
    const target = props.linked === "Secondary" ? secondary : tertiary;
    const link = yield* Azure.Redis.LinkedServer("Link", {
      resourceGroup: group.resourceGroupName,
      cache: primary.cacheName,
      linkedCacheId: target.cacheId,
      linkedCacheLocation: target.location,
    });
    return { group, primary, secondary, tertiary, link };
  });

// Three Premium P1 caches (~$0.55/hour each) that take 30-40 minutes to
// provision, plus 5-15 minutes per link/unlink: roughly $2-3 and well over
// an hour per run. Geo-replication needs a cache in a second region, and
// the testing subscription may only create Azure Cache for Redis in eastus
// (see the probe below), so this runs only on an entitled subscription.
test.provider.skipIf(!runPaidOnly)(
  "link, re-link (replace), and unlink geo-replicated redis caches",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, primary, secondary, link } = yield* stack.deploy(
        program({ linked: "Secondary" }),
      );
      expect(link.linkedServerName).toEqual(secondary.cacheName);
      expect(link.serverRole).toEqual("Secondary");
      expect(link.geoReplicatedPrimaryHostName).toBeDefined();
      const observed = yield* getLink(
        group.resourceGroupName,
        primary.cacheName,
        link.linkedServerName,
      );
      expect(observed.properties?.linkedRedisCacheId?.toLowerCase()).toEqual(
        secondary.cacheId.toLowerCase(),
      );

      // Replace: link the tertiary cache instead.
      const relinked = yield* stack.deploy(program({ linked: "Tertiary" }));
      expect(relinked.link.linkedServerName).toEqual(
        relinked.tertiary.cacheName,
      );
      expect(
        yield* waitGone(
          getLink(
            group.resourceGroupName,
            primary.cacheName,
            link.linkedServerName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getLink(
            group.resourceGroupName,
            primary.cacheName,
            relinked.link.linkedServerName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);

// Ungated probe (instant, no cost): outside the regions where it already
// had caches, the subscription is refused new Azure Cache for Redis caches
// with a typed error, so the secondary of a link cannot be created.
test.provider(
  "a new redis cache in a second region is refused with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const failure = yield* redis
        .CreateRedis({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          name: `${group.resourceGroupName.toLowerCase().slice(0, 40)}-wus2`
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-"),
          location: "westus2",
          properties: { sku: { name: "Basic", family: "C", capacity: 0 } },
        })
        .pipe(Effect.flip);
      expect(failure._tag).toEqual("RedisCacheRetiring");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
