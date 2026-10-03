import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as redis from "@distilled.cloud/azure/redis";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
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
// an hour per run.
test.provider.skipIf(!runExpensive)(
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
